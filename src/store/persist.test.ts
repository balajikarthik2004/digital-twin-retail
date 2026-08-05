import { beforeEach, describe, expect, it, vi } from 'vitest'
import layoutsDoc from '../data/layouts.json'
import { createRoutingContext } from '../pathfinding/route'
import { applyPutaway, planPutaway } from '../inbound/plan'
import { createManualReceipt, resetReceiptSequence } from '../inbound/receipts'
import { generateWarehouse } from '../warehouse/generate'
import type { WarehouseConfig } from '../warehouse/types'
import { applyOverrides, clearSnapshot, loadSnapshot, overrideFor, saveSnapshot } from './persist'

const config = (layoutsDoc as unknown as { layouts: WarehouseConfig[] }).layouts.find(
  (c) => c.id === 'dc-north',
)!

/** Minimal localStorage, since these tests run in Node. */
function installStorage(impl?: Partial<Storage>) {
  const data = new Map<string, string>()
  const store: Storage = {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
    ...impl,
  }
  vi.stubGlobal('localStorage', store)
  return data
}

describe('inbound persistence', () => {
  beforeEach(() => {
    installStorage()
    resetReceiptSequence()
  })

  it('round-trips a putaway onto a freshly generated model', () => {
    const first = generateWarehouse(config)
    const ctx = createRoutingContext(first.graph)
    const receipt = createManualReceipt({
      name: 'Persisted Cold Brew',
      skuId: null,
      category: 'Beverages',
      velocity: 'fast',
      qty: 96,
      unitVolume: 1.1,
    })
    const plan = planPutaway(first, ctx, receipt, receipt.lines[0])!
    applyPutaway(first, receipt.lines[0], plan.chosenBinId, 30, plan.route.distance)

    const override = overrideFor(first, plan.chosenBinId)!
    saveSnapshot(config.id, {
      receipts: [receipt],
      inboundLog: [],
      binOverrides: { [plan.chosenBinId]: override },
      seq: { receipt: 2, line: 2 },
    })

    // A brand-new model has the location back at its seeded contents...
    const reloaded = generateWarehouse(config)
    expect(reloaded.binsById.get(plan.chosenBinId)!.sku.name).not.toBe('Persisted Cold Brew')

    // ...until the snapshot is replayed over it.
    const snapshot = loadSnapshot(config.id)!
    expect(applyOverrides(reloaded, snapshot.binOverrides)).toBe(1)

    const restored = reloaded.binsById.get(plan.chosenBinId)!
    expect(restored.sku.name).toBe('Persisted Cold Brew')
    expect(restored.sku.stock).toBe(96)
    expect(restored.sku.stockInitial).toBe(96)
    expect(restored.sku.velocity).toBe('fast')
    expect(restored.capacity).toBe(first.binsById.get(plan.chosenBinId)!.capacity)
    expect(snapshot.receipts[0].ref).toBe(receipt.ref)
    expect(snapshot.seq).toEqual({ receipt: 2, line: 2 })
  })

  it('keeps layouts apart and clears only what it is asked to', () => {
    saveSnapshot('dc-north', { receipts: [], inboundLog: [], binOverrides: {}, seq: { receipt: 3, line: 4 } })
    saveSnapshot('dc-compact', { receipts: [], inboundLog: [], binOverrides: {}, seq: { receipt: 9, line: 9 } })

    expect(loadSnapshot('dc-north')!.seq.receipt).toBe(3)
    expect(loadSnapshot('dc-compact')!.seq.receipt).toBe(9)

    clearSnapshot('dc-north')
    expect(loadSnapshot('dc-north')).toBeNull()
    expect(loadSnapshot('dc-compact')!.seq.receipt).toBe(9)
  })

  it('never lets a bad or unavailable store break the app', () => {
    installStorage({
      getItem: () => '{ not json',
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    })
    expect(loadSnapshot(config.id)).toBeNull()
    // A failed save must not propagate — the putaway itself already succeeded.
    expect(() =>
      saveSnapshot(config.id, { receipts: [], inboundLog: [], binOverrides: {}, seq: { receipt: 1, line: 1 } }),
    ).not.toThrow()
    expect(() => clearSnapshot(config.id)).not.toThrow()
  })

  it('drops overrides that no longer resolve against the model', () => {
    const model = generateWarehouse(config)
    const applied = applyOverrides(model, {
      'nope:0-L-0-0-0': {
        name: 'Ghost',
        category: 'x',
        velocity: 'slow',
        unitVolume: 1,
        capacity: 10,
        stock: 5,
        stockInitial: 5,
        replenPoint: 1,
      },
    })
    expect(applied).toBe(0)
  })

  it('clamps a restored stock level to the location it lands in', () => {
    const model = generateWarehouse(config)
    const bin = model.bins[0]
    applyOverrides(model, {
      [bin.id]: {
        name: bin.sku.name,
        category: bin.sku.category,
        velocity: bin.sku.velocity,
        unitVolume: bin.sku.unitVolume,
        capacity: 50,
        stock: 9_999,
        stockInitial: 9_999,
        replenPoint: 5,
      },
    })
    expect(bin.capacity).toBe(50)
    expect(bin.sku.stock).toBe(50)
    expect(bin.sku.stockInitial).toBe(50)
  })
})
