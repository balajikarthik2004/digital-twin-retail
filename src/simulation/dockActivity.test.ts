import { describe, expect, it } from 'vitest'
import type { Receipt, ReceiptLine } from '../inbound/types'
import {
  deriveDockActivity,
  dockBoardLines,
  dockIndexForReceipt,
  type DockActivityInput,
} from './dockActivity'
import { TRAILER_CAPACITY, TRAILER_DWELL } from './packLine'
import type { DockMetrics, Parcel } from './types'

const DOORS = [
  { id: 'dock-0', label: 'Dock 01' },
  { id: 'dock-1', label: 'Dock 02' },
]

function row(over: Partial<DockMetrics> = {}): DockMetrics {
  return {
    id: 'dock-0',
    label: 'Dock 01',
    channels: ['Ecommerce'],
    inbound: 0,
    staged: 0,
    dispatched: 0,
    trailers: 0,
    cartons: 0,
    stagedCartons: 0,
    oldestStagedAt: 0,
    ...over,
  }
}

function line(over: Partial<ReceiptLine> = {}): ReceiptLine {
  return {
    id: `rl-${Math.round(over.expectedQty ?? 0)}`,
    skuId: 'sku-1',
    name: 'Oat milk 1L',
    category: 'Ambient',
    velocity: 'fast',
    expectedQty: 100,
    receivedQty: 0,
    unitVolume: 1,
    status: 'expected',
    receivedAt: null,
    storedBinId: null,
    storedCode: null,
    storedAt: null,
    storedQty: 0,
    ...over,
  }
}

function receipt(id: string, arrivedAt: number, lines: ReceiptLine[]): Receipt {
  return {
    id,
    ref: `GRN-${id.split('-')[1]?.padStart(5, '0')}`,
    po: 'PO-1',
    supplier: 'Nordvale Foods',
    arrivedAt,
    unplanned: false,
    lines,
  }
}

function parcel(dockIndex: number, stage: Parcel['stage']): Parcel {
  return { dockIndex, stage } as unknown as Parcel
}

function derive(over: Partial<DockActivityInput> = {}) {
  return deriveDockActivity({
    docks: DOORS,
    metrics: null,
    parcels: [],
    receipts: [],
    time: 0,
    ...over,
  })
}

describe('dockIndexForReceipt', () => {
  it('rotates trailers across the doors, and never off the end of them', () => {
    expect(dockIndexForReceipt('grn-1', 2)).toBe(0)
    expect(dockIndexForReceipt('grn-2', 2)).toBe(1)
    expect(dockIndexForReceipt('grn-3', 2)).toBe(0)
    for (const id of ['grn-1', 'grn-9', 'grn-40', 'no-digits', '']) {
      const index = dockIndexForReceipt(id, 3)
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThan(3)
    }
  })

  it('is stable, so a trailer never appears to hop doors between frames', () => {
    expect(dockIndexForReceipt('grn-17', 4)).toBe(dockIndexForReceipt('grn-17', 4))
  })

  it('survives a layout with no doors at all', () => {
    expect(dockIndexForReceipt('grn-1', 0)).toBe(0)
    expect(derive({ docks: [] })).toEqual([])
  })
})

describe('deriveDockActivity — outbound', () => {
  it('reads the pad as a share of a trailer, and counts down to the seal', () => {
    const [door] = derive({
      metrics: [row({ staged: 4, stagedCartons: 9, oldestStagedAt: 100 })],
      parcels: [parcel(0, 'conveying'), parcel(0, 'conveying'), parcel(1, 'conveying')],
      time: 160,
    })

    expect(door.flow).toBe('outbound')
    expect(door.outbound.enRoute).toBe(2)
    expect(door.outbound.load).toBeCloseTo(4 / TRAILER_CAPACITY, 6)
    expect(door.outbound.sealIn).toBe(TRAILER_DWELL - 60)
    expect(door.outbound.full).toBe(false)
    expect(door.progress).toBeCloseTo(door.outbound.load, 6)
  })

  it('treats a full trailer as going now, not on the dwell clock', () => {
    const [door] = derive({
      metrics: [row({ staged: TRAILER_CAPACITY, oldestStagedAt: 10 })],
      time: 12,
    })
    expect(door.outbound.full).toBe(true)
    expect(door.outbound.sealIn).toBe(0)
    expect(door.outbound.load).toBe(1)
    expect(dockBoardLines(door).detail).toContain('sealing')
  })

  it('leaves an untouched door idle rather than inventing work for it', () => {
    const [door] = derive({ metrics: [row(), row({ id: 'dock-1' })] })
    expect(door.flow).toBe('idle')
    expect(door.progress).toBe(0)
    expect(door.outbound.sealIn).toBeNull()
    expect(door.headline).toMatch(/no trailer/i)
  })

  it('works before the engine has published anything', () => {
    const doors = derive({ metrics: null })
    expect(doors).toHaveLength(2)
    expect(doors.every((d) => d.flow === 'idle' && d.outbound.capacity === TRAILER_CAPACITY)).toBe(true)
  })
})

describe('deriveDockActivity — inbound', () => {
  const trailer = (over: Partial<ReceiptLine>[] = [{}, {}]) =>
    receipt('grn-1', 0, over.map((o) => line(o)))

  it('puts a door on inbound while a trailer is still being counted', () => {
    const [door] = derive({
      receipts: [trailer([{ status: 'received', receivedQty: 90 }, {}])],
      time: 300,
    })

    expect(door.flow).toBe('inbound')
    expect(door.inbound?.atDoor).toBe(true)
    expect(door.inbound?.linesCounted).toBe(1)
    expect(door.inbound?.unitsCounted).toBe(90)
    expect(door.inbound?.unitsToPutAway).toBe(90)
    expect(door.headline).toContain('GRN-00001')
    expect(door.progress).toBeCloseTo(0.25, 6)
  })

  it('hands the door back once the trailer is counted off — the putaway is floor work', () => {
    const [door] = derive({
      receipts: [
        trailer([
          { status: 'received', receivedQty: 90 },
          { status: 'received', receivedQty: 40 },
        ]),
      ],
      metrics: [row({ staged: 2, oldestStagedAt: 0 })],
      time: 300,
    })

    expect(door.inbound?.atDoor).toBe(false)
    expect(door.flow).toBe('outbound')
    // The trailer is still reported, because 130 units are on a pallet somewhere.
    expect(door.inbound?.unitsToPutAway).toBe(130)
  })

  it('drops a fully stored trailer and shows the next one waiting', () => {
    const stored = receipt('grn-1', 0, [line({ status: 'stored', receivedQty: 80, storedQty: 80 })])
    const next = receipt('grn-3', 0, [line()])
    const [door] = derive({ receipts: [stored, next], time: 100 })

    expect(door.inbound?.ref).toBe('GRN-00003')
    expect(door.inboundQueue).toBe(0)
  })

  it('holds a trailer that has not arrived yet in the yard, not on the door', () => {
    const [door] = derive({ receipts: [receipt('grn-1', 900, [line()])], time: 100 })
    expect(door.flow).toBe('idle')
    expect(door.inbound).toBeNull()
    expect(door.inboundQueue).toBe(1)
  })

  it('counts a trailer as arrived the moment someone counts against it, clock or not', () => {
    const [door] = derive({
      receipts: [receipt('grn-1', 9000, [line({ status: 'received', receivedQty: 12 })])],
      time: 0,
    })
    expect(door.inbound?.ref).toBe('GRN-00001')
  })

  it('spreads trailers over the doors rather than piling them on the first', () => {
    const doors = derive({
      receipts: [receipt('grn-1', 0, [line()]), receipt('grn-2', 0, [line()])],
      time: 10,
    })
    expect(doors[0].inbound?.ref).toBe('GRN-00001')
    expect(doors[1].inbound?.ref).toBe('GRN-00002')
  })
})

describe('dockBoardLines', () => {
  it('never returns an empty sign, whatever the door is doing', () => {
    const cases = [
      derive()[0],
      derive({ metrics: [row({ staged: 3, oldestStagedAt: 0 })], time: 30 })[0],
      derive({ receipts: [receipt('grn-1', 0, [line()])], time: 5 })[0],
    ]
    for (const state of cases) {
      const { primary, detail } = dockBoardLines(state)
      expect(primary.length).toBeGreaterThan(0)
      expect(detail.length).toBeGreaterThan(0)
    }
  })
})
