import { describe, expect, it } from 'vitest'
import type { Bin } from '../warehouse/types'
import { MIN_BIN_FILL, binFill, binOccupancy } from './buildWarehouse'

/** Only the two fields the fill depends on matter here. */
function bin(stock: number, capacity: number): Bin {
  return { capacity, sku: { stock } } as unknown as Bin
}

/** The occupancy overlay also reads the replen point. */
function stocked(stock: number, replenPoint: number): Bin {
  return { capacity: 500, sku: { stock, replenPoint } } as unknown as Bin
}

describe('binFill', () => {
  it('draws a location at the height of what is in it', () => {
    expect(binFill(bin(100, 100))).toBe(1)
    expect(binFill(bin(50, 100))).toBeCloseTo(MIN_BIN_FILL + (1 - MIN_BIN_FILL) * 0.5, 6)
    expect(binFill(bin(0, 100))).toBe(MIN_BIN_FILL)
  })

  it('never collapses an empty location out of reach', () => {
    // An empty location is exactly what an inbound putaway is looking for: it has
    // to stay visible, tintable as a candidate and big enough to click.
    for (const [stock, capacity] of [
      [0, 240],
      [0, 0],
      [1, 5000],
    ] as const) {
      const fill = binFill(bin(stock, capacity))
      expect(fill).toBeGreaterThanOrEqual(MIN_BIN_FILL)
      expect(MIN_BIN_FILL).toBeGreaterThan(0.3)
    }
  })

  it('clamps rather than growing through the shelf above', () => {
    expect(binFill(bin(900, 100))).toBe(1)
    expect(binFill(bin(-20, 100))).toBe(MIN_BIN_FILL)
  })

  it('draws an empty location and a low one at different heights', () => {
    // The overlay recolours them; the fill still has to tell them apart, or a
    // location one pick away from empty would look identical to an empty one.
    expect(binFill(bin(0, 100))).toBeLessThan(binFill(bin(10, 100)))
  })

  it('is monotonic in stock, so a picked location only ever gets shorter', () => {
    let previous = 0
    for (let stock = 0; stock <= 200; stock += 10) {
      const fill = binFill(bin(stock, 200))
      expect(fill).toBeGreaterThanOrEqual(previous)
      previous = fill
    }
    expect(previous).toBe(1)
  })
})

describe('binOccupancy', () => {
  it('calls a location empty only when there is genuinely nothing in it', () => {
    // One unit of the wrong SKU is enough to stop a putaway re-slotting it, so
    // "nearly empty" is a replen alert, not an empty location.
    expect(binOccupancy(stocked(0, 20))).toBe('empty')
    expect(binOccupancy(stocked(1, 20))).toBe('low')
    expect(binOccupancy(stocked(20, 20))).toBe('low')
    expect(binOccupancy(stocked(21, 20))).toBe('stocked')
  })

  it('flags a location that has just crossed its replen point', () => {
    expect(binOccupancy(stocked(400, 120))).toBe('stocked')
    expect(binOccupancy(stocked(120, 120))).toBe('low')
  })

  it('never leaves a location without a state', () => {
    for (const [stock, replen] of [
      [0, 0],
      [500, 0],
      [-5, 10],
    ] as const) {
      expect(['empty', 'low', 'stocked']).toContain(binOccupancy(stocked(stock, replen)))
    }
  })
})
