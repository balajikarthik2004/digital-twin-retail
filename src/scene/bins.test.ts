import { describe, expect, it } from 'vitest'
import type { Bin } from '../warehouse/types'
import { MIN_BIN_FILL, binFill } from './buildWarehouse'

/** Only the two fields the fill depends on matter here. */
function bin(stock: number, capacity: number): Bin {
  return { capacity, sku: { stock } } as unknown as Bin
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
