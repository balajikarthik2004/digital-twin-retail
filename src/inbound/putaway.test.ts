import { beforeEach, describe, expect, it } from 'vitest'
import layoutsDoc from '../data/layouts.json'
import { createRoutingContext } from '../pathfinding/route'
import { generateWarehouse } from '../warehouse/generate'
import type { WarehouseConfig } from '../warehouse/types'
import { describeRoute } from './directions'
import { binFree, isEmpty, summariseFreeSpace } from './freeSpace'
import { applyPutaway, planPutaway } from './plan'
import { listAvailable, rankLocations } from './putaway'
import {
  createManualReceipt,
  generateReceipts,
  receiveLine,
  resetReceiptSequence,
} from './receipts'
import {
  outstandingUnits,
  receiptStatus,
  variance,
  type Receipt,
  type ReceiptLine,
} from './types'

/**
 * Count a line in at the advised quantity. Nothing can be put away before it has
 * been received, so every putaway test has to go through the goods receipt first.
 */
function received(line: ReceiptLine): ReceiptLine {
  receiveLine(line, line.expectedQty, 0)
  return line
}

const configs = (layoutsDoc as unknown as { layouts: WarehouseConfig[] }).layouts
const config = configs.find((c) => c.id === 'dc-north')!

/** Rebuilt per test — putaway mutates stock, and stock is what everything reads. */
function freshModel() {
  return generateWarehouse(config)
}

describe('storage capacity', () => {
  const model = freshModel()

  it('gives every location a physical capacity it never exceeds', () => {
    for (const bin of model.bins) {
      expect(bin.capacity).toBeGreaterThan(0)
      expect(bin.sku.stock).toBeLessThanOrEqual(bin.capacity)
      expect(bin.sku.unitVolume).toBeGreaterThan(0)
    }
  })

  it('leaves genuinely empty locations to put new lines into', () => {
    const empty = model.bins.filter(isEmpty)
    expect(empty.length).toBeGreaterThan(20)
    expect(empty.length).toBeLessThan(model.bins.length * 0.3)
  })

  it('summarises free space consistently with the per-bin numbers', () => {
    const s = summariseFreeSpace(model)
    expect(s.locations).toBe(model.bins.length)
    expect(s.capacityUnits).toBe(model.bins.reduce((t, b) => t + b.capacity, 0))
    expect(s.onHandUnits).toBe(model.bins.reduce((t, b) => t + b.sku.stock, 0))
    expect(s.freeUnits).toBe(model.bins.reduce((t, b) => t + binFree(b), 0))
    expect(s.occupancy).toBeGreaterThan(0)
    expect(s.occupancy).toBeLessThan(1)
    expect(s.byAisle).toHaveLength(config.aisles)
    expect(s.byLevel).toHaveLength(config.levels)
    // Every location is counted exactly once in each cut.
    for (const cut of [s.byAisle, s.byLevel, s.byVelocity]) {
      expect(cut.reduce((t, b) => t + b.locations, 0)).toBe(model.bins.length)
    }
  })
})

describe('putaway location ranking', () => {
  const model = freshModel()
  const ctx = createRoutingContext(model.graph)

  it('never suggests a location holding a different SKU', () => {
    const target = model.bins.find((b) => b.sku.stock > 0 && binFree(b) > 50)!
    const ranked = rankLocations(model, ctx, {
      skuId: target.sku.id,
      velocity: target.sku.velocity,
      qty: 40,
      unitVolume: target.sku.unitVolume,
    })
    expect(ranked.length).toBeGreaterThan(0)
    for (const c of ranked) {
      expect(c.fit === 'topUp' ? c.bin.sku.id === target.sku.id : isEmpty(c.bin)).toBe(true)
    }
  })

  it("prefers the SKU's own home location over opening a new one", () => {
    const target = model.bins.find((b) => b.sku.stock > 0 && binFree(b) > 100)!
    const ranked = rankLocations(model, ctx, {
      skuId: target.sku.id,
      velocity: target.sku.velocity,
      qty: 30,
      unitVolume: target.sku.unitVolume,
    })
    expect(ranked[0].binId).toBe(target.id)
    expect(ranked[0].fit).toBe('topUp')
    expect(ranked[0].reasons[0]).toMatch(/home location/i)
  })

  it('offers only empty locations for a line new to the facility', () => {
    const ranked = rankLocations(model, ctx, {
      skuId: null,
      velocity: 'medium',
      qty: 60,
      unitVolume: 2.5,
    })
    expect(ranked.length).toBeGreaterThan(0)
    for (const c of ranked) {
      expect(c.fit).toBe('empty')
      expect(isEmpty(c.bin)).toBe(true)
    }
  })

  it('warns when the delivery is too big for one location', () => {
    const empties = model.bins.filter(isEmpty)
    const ranked = rankLocations(model, ctx, {
      skuId: null,
      velocity: 'slow',
      qty: 500_000,
      unitVolume: 6,
    })
    expect(empties.length).toBeGreaterThan(0)
    expect(ranked[0].fits).toBeLessThan(500_000)
    expect(ranked[0].warnings.join(' ')).toMatch(/units fit/i)
  })

  it('ranks a near location above an otherwise identical far one', () => {
    const ranked = rankLocations(
      model,
      ctx,
      { skuId: null, velocity: 'medium', qty: 20, unitVolume: 3 },
      { limit: 40 },
    )
    const sameShape = ranked.filter(
      (c) => c.bin.sku.velocity === 'medium' && c.bin.level === ranked[0].bin.level && c.fits === 20,
    )
    if (sameShape.length > 1) {
      const [first, ...rest] = sameShape
      for (const other of rest) {
        if (other.distance > first.distance + 5) expect(other.score).toBeLessThanOrEqual(first.score)
      }
    }
    expect(ranked[0].distance).toBeLessThanOrEqual(ranked[ranked.length - 1].distance + 1e-6)
  })
})

describe('putaway routing and directions', () => {
  let model = freshModel()
  let receipts: Receipt[] = []

  beforeEach(() => {
    model = freshModel()
    resetReceiptSequence()
    receipts = generateReceipts(model, { count: 6, seed: 4242 })
  })

  it('routes from goods-in to the chosen location on the pickers own graph', () => {
    const ctx = createRoutingContext(model.graph)
    const receipt = receipts[0]
    const plan = planPutaway(model, ctx, receipt, received(receipt.lines[0]))!

    expect(plan).not.toBeNull()
    expect(plan.route.nodePath[0]).toBe(model.receiving)
    const chosen = model.binsById.get(plan.chosenBinId)!
    expect(plan.route.nodePath[plan.route.nodePath.length - 1]).toBe(chosen.node)
    expect(plan.route.distance).toBeGreaterThan(0)
    expect(plan.estimateSec).toBeGreaterThan(0)
  })

  it('produces directions that add up to the route length', () => {
    const ctx = createRoutingContext(model.graph)
    const receipt = receipts[1]
    const plan = planPutaway(model, ctx, receipt, received(receipt.lines[0]))!
    const chosen = model.binsById.get(plan.chosenBinId)!

    const walked = plan.directions.reduce((t, s) => t + s.metres, 0)
    expect(walked).toBeCloseTo(Math.round(plan.route.distance), -1)
    expect(plan.directions[0].text).toMatch(/Inbound Receiving|aisle|apron/i)
    // The last instruction always names the shelf being filled.
    expect(plan.directions[plan.directions.length - 1].text).toContain(chosen.code)
  })

  it('honours an explicitly chosen location', () => {
    const ctx = createRoutingContext(model.graph)
    const receipt = receipts[2]
    const line = received(receipt.lines[0])
    const options = planPutaway(model, ctx, receipt, line)!
    const alternative = options.candidates[options.candidates.length - 1]

    const replanned = planPutaway(model, ctx, receipt, line, { chosenBinId: alternative.binId })!
    expect(replanned.chosenBinId).toBe(alternative.binId)
    expect(describeRoute(model, replanned.route, alternative.bin).length).toBeGreaterThan(1)
  })

  /**
   * The manual picker lists every free location, not the shortlist — so a plan
   * asked for a location ranked 200th has to route to THAT shelf. Falling back
   * to the recommendation would silently draw the wrong route.
   */
  it('routes to a chosen location far outside the shortlist', () => {
    const ctx = createRoutingContext(model.graph)
    const receipt = receipts[3]
    const line = received(receipt.lines[0])

    const everything = listAvailable(model, ctx, {
      skuId: line.skuId,
      velocity: line.velocity,
      qty: outstandingUnits(line),
      unitVolume: line.unitVolume,
    })
    expect(everything.length).toBeGreaterThan(50)

    const shortlist = planPutaway(model, ctx, receipt, line)!.candidates
    // Something no shortlist would ever surface.
    const distant = everything[everything.length - 1]
    expect(shortlist.some((c) => c.binId === distant.binId)).toBe(false)

    const plan = planPutaway(model, ctx, receipt, line, { chosenBinId: distant.binId })!
    expect(plan.chosenBinId).toBe(distant.binId)
    // The walk must actually end at that shelf, not at the recommendation.
    expect(plan.route.nodePath[plan.route.nodePath.length - 1]).toBe(distant.bin.node)
    expect(plan.directions[plan.directions.length - 1].text).toContain(distant.code)
    // And it has to appear on the plan, or the scene cannot highlight it.
    expect(plan.candidates.some((c) => c.binId === distant.binId)).toBe(true)
  })

  it('refuses a chosen location that is not legal for the line', () => {
    const ctx = createRoutingContext(model.graph)
    const receipt = receipts[4]
    const line = received(receipt.lines[0])
    // Occupied by some other SKU — never a legal target.
    const occupied = model.bins.find((b) => b.sku.stock > 0 && b.sku.id !== line.skuId)!

    expect(planPutaway(model, ctx, receipt, line, { chosenBinId: occupied.id })).toBeNull()
  })
})

describe('confirming a putaway', () => {
  it('adds the stock to the shelf and marks the line stored', () => {
    const model = freshModel()
    const ctx = createRoutingContext(model.graph)
    resetReceiptSequence()
    const receipt = createManualReceipt({
      name: 'Kestrel Cold Brew',
      skuId: null,
      category: 'Beverages',
      velocity: 'fast',
      qty: 24,
      unitVolume: 1.2,
    })
    const line = receipt.lines[0]
    const plan = planPutaway(model, ctx, receipt, line)!
    const bin = model.binsById.get(plan.chosenBinId)!

    expect(bin.sku.stock).toBe(0)
    const result = applyPutaway(model, line, plan.chosenBinId, 120, plan.route.distance)!

    expect(result.qty).toBe(24)
    expect(result.remaining).toBe(0)
    expect(bin.sku.stock).toBe(24)
    // A shift reset must not un-receive physically delivered goods.
    expect(bin.sku.stockInitial).toBe(24)
    expect(bin.sku.name).toBe('Kestrel Cold Brew')
    expect(line.status).toBe('stored')
    expect(line.storedCode).toBe(bin.code)
    expect(line.storedAt).toBe(120)
  })

  it('splits a delivery that overflows one location', () => {
    const model = freshModel()
    const ctx = createRoutingContext(model.graph)
    resetReceiptSequence()
    const receipt = createManualReceipt({
      name: 'Ironwood Cat Litter',
      skuId: null,
      category: 'Pet',
      velocity: 'slow',
      qty: 900_000,
      unitVolume: 12,
    })
    const line = receipt.lines[0]
    const first = planPutaway(model, ctx, receipt, line)!
    const stored = applyPutaway(model, line, first.chosenBinId, 60)!

    expect(stored.remaining).toBeGreaterThan(0)
    expect(line.status).toBe('received')

    // The remainder re-plans onto a different location.
    const second = planPutaway(model, ctx, receipt, line)!
    expect(second.chosenBinId).not.toBe(first.chosenBinId)
  })

  it('refuses to mix a second SKU into an occupied location', () => {
    const model = freshModel()
    resetReceiptSequence()
    const occupied = model.bins.find((b) => b.sku.stock > 0 && binFree(b) > 50)!
    const receipt = createManualReceipt({
      name: 'Something Else Entirely',
      skuId: null,
      category: 'Pantry',
      velocity: 'medium',
      qty: 10,
      unitVolume: 2,
    })

    const before = occupied.sku.stock
    expect(applyPutaway(model, receipt.lines[0], occupied.id, 0)).toBeNull()
    expect(occupied.sku.stock).toBe(before)
  })
})

describe('goods receipt', () => {
  it('will not put away a line that has not been counted in', () => {
    const model = freshModel()
    const ctx = createRoutingContext(model.graph)
    resetReceiptSequence()
    const receipt = generateReceipts(model, { count: 1, seed: 5 })[0]
    const line = receipt.lines[0]

    // Advised only: the quantity is still the supplier's claim.
    expect(line.status).toBe('expected')
    expect(planPutaway(model, ctx, receipt, line)).toBeNull()
    expect(applyPutaway(model, line, model.bins.find(isEmpty)!.id, 0)).toBeNull()

    // Counted in, and now there is work to plan.
    receiveLine(line, line.expectedQty, 90)
    expect(line.status).toBe('received')
    expect(line.receivedAt).toBe(90)
    expect(planPutaway(model, ctx, receipt, line)).not.toBeNull()
  })

  it('accepts a short count and puts away only what turned up', () => {
    const model = freshModel()
    const ctx = createRoutingContext(model.graph)
    resetReceiptSequence()
    const receipt = generateReceipts(model, { count: 1, seed: 11 })[0]
    const line = receipt.lines[0]
    const short = Math.max(1, Math.floor(line.expectedQty / 3))

    receiveLine(line, short, 30)
    expect(variance(line)).toBe(short - line.expectedQty)
    expect(variance(line)).toBeLessThan(0)
    expect(outstandingUnits(line)).toBe(short)

    // The plan is sized to the count, not to the advice note.
    const plan = planPutaway(model, ctx, receipt, line)!
    const chosen = plan.candidates.find((c) => c.binId === plan.chosenBinId)!
    expect(chosen.fits).toBeLessThanOrEqual(short)

    const result = applyPutaway(model, line, plan.chosenBinId, 40)!
    expect(result.qty).toBe(short)
    expect(line.status).toBe('stored')
    // A shortfall does not leave putaway work behind.
    expect(outstandingUnits(line)).toBe(0)
  })

  it('accepts an over-count and puts the surplus away too', () => {
    const model = freshModel()
    const ctx = createRoutingContext(model.graph)
    resetReceiptSequence()
    const receipt = generateReceipts(model, { count: 1, seed: 12 })[0]
    const line = receipt.lines[0]
    const over = line.expectedQty + 7

    receiveLine(line, over, 30)
    expect(variance(line)).toBe(7)
    expect(outstandingUnits(line)).toBe(over)
    expect(planPutaway(model, ctx, receipt, line)).not.toBeNull()
  })

  it('a zero count leaves nothing to put away', () => {
    const model = freshModel()
    const ctx = createRoutingContext(model.graph)
    resetReceiptSequence()
    const receipt = generateReceipts(model, { count: 1, seed: 13 })[0]
    const line = receipt.lines[0]

    receiveLine(line, 0, 30)
    expect(line.status).toBe('received')
    expect(outstandingUnits(line)).toBe(0)
    expect(planPutaway(model, ctx, receipt, line)).toBeNull()
  })

  it('rolls a delivery up through expected → receiving → received → stored', () => {
    const model = freshModel()
    resetReceiptSequence()
    // A two-line delivery, so the part-received state is reachable.
    const receipt = generateReceipts(model, { count: 12, seed: 21 }).find((r) => r.lines.length >= 2)!

    expect(receiptStatus(receipt)).toBe('expected')
    receiveLine(receipt.lines[0], receipt.lines[0].expectedQty, 10)
    expect(receiptStatus(receipt)).toBe('receiving')
    for (const l of receipt.lines) receiveLine(l, l.expectedQty, 10)
    expect(receiptStatus(receipt)).toBe('received')
    for (const l of receipt.lines) l.status = 'stored'
    expect(receiptStatus(receipt)).toBe('stored')
  })

  it('an unplanned delivery is received the moment it is booked in', () => {
    resetReceiptSequence()
    const receipt = createManualReceipt({
      name: 'Turned Up Unannounced',
      skuId: null,
      category: 'Pantry',
      velocity: 'medium',
      qty: 42,
      unitVolume: 2,
      at: 75,
    })
    const line = receipt.lines[0]
    expect(receipt.unplanned).toBe(true)
    expect(line.status).toBe('received')
    expect(line.expectedQty).toBe(42)
    expect(line.receivedQty).toBe(42)
    expect(line.receivedAt).toBe(75)
    expect(variance(line)).toBe(0)
    expect(receiptStatus(receipt)).toBe('received')
  })
})

describe('inbound receipt generation', () => {
  it('books in a realistic mix of top-ups and new lines', () => {
    const model = freshModel()
    resetReceiptSequence()
    const receipts = generateReceipts(model, { count: 12, seed: 77 })

    expect(receipts).toHaveLength(12)
    const lines = receipts.flatMap((r) => r.lines)
    expect(lines.some((l) => l.skuId !== null)).toBe(true)
    expect(lines.some((l) => l.skuId === null)).toBe(true)

    for (const line of lines) {
      expect(line.expectedQty).toBeGreaterThan(0)
      // Advised, not counted: nothing is received until an operator says so.
      expect(line.status).toBe('expected')
      expect(line.receivedQty).toBe(0)
      expect(line.receivedAt).toBeNull()
      // A top-up is never advised beyond what its home location could hold.
      if (line.skuId) {
        const bin = model.binBySku.get(line.skuId)!
        expect(line.expectedQty).toBeLessThanOrEqual(bin.capacity)
      }
    }
    // Arrivals are ordered along the shift clock.
    for (let i = 1; i < receipts.length; i++) {
      expect(receipts[i].arrivedAt).toBeGreaterThanOrEqual(receipts[i - 1].arrivedAt)
    }
  })

  it('is deterministic for a given seed', () => {
    const model = freshModel()
    resetReceiptSequence()
    const a = generateReceipts(model, { count: 5, seed: 9 })
    resetReceiptSequence()
    const b = generateReceipts(model, { count: 5, seed: 9 })
    expect(a).toEqual(b)
  })
})
