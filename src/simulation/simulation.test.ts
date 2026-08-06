import { describe, expect, it } from 'vitest'
import layoutsDoc from '../data/layouts.json'
import realCatalogDoc from '../data/realCatalog.json'
import sampleOrdersDoc from '../data/sampleOrders.json'
import type { CatalogEntry } from '../warehouse/catalog'
import { generateWarehouse } from '../warehouse/generate'
import type { WarehouseConfig } from '../warehouse/types'
import { compareStrategies } from './compare'
import { AGENT_COLORS, MAX_AGENTS, SimulationEngine } from './engine'
import { generateOrders, importOrders, resetOrderSequence } from './orderGenerator'
import { PICKER_KINDS, PICKER_PROFILES, type PickerKind } from './pickerProfiles'
import { slaFor } from './sla'
import type { SimSettings } from './types'

const configs = (layoutsDoc as unknown as { layouts: WarehouseConfig[] }).layouts
const config = configs.find((c) => c.id === 'dc-north')!
// Deliberately catalog-less: every other test in this file leans on this
// fixture's exact RNG-derived stock/capacity distribution, so it stays plain
// synthetic. The one test that needs the real catalogue builds its own model.
const model = generateWarehouse(config)

/**
 * Baseline fixture with every behavioural switch OFF, so the core movement and
 * bookkeeping assertions stay deterministic and easy to reason about. Tests for
 * the smarter behaviours opt into them explicitly.
 */
const settings: SimSettings = {
  agentCount: 3,
  strategyId: 'tsp-2opt',
  pickerKind: 'cart',
  pickerSpeed: 1.3,
  pickTimeSec: 12,
  perUnitTimeSec: 2.5,
  unloadTimeSec: 25,
  congestionRadius: 2.2,
  smartDispatch: false,
  batchOrders: false,
  rerouting: false,
  restBreaks: false,
  stockDepletion: false,
  // Pack-out is staffed generously in the baseline so the assertions below are
  // about picking; the pack-line suite constrains it deliberately.
  packStaff: config.packStations,
  packSetupSec: 22,
  packPerLineSec: 5.5,
  packPerUnitSec: 0.9,
  unitsPerCarton: 14,
  conveyorSpeed: 0.85,
  conveyorSortation: true,
  packBufferLimit: 10,
}

/** Run the engine to completion (or until a step budget is exhausted). */
function runToCompletion(engine: SimulationEngine, maxSeconds = 20000, dt = 0.25) {
  engine.start()
  let elapsed = 0
  while (engine.time < maxSeconds) {
    engine.step(dt)
    elapsed += dt
    if (!engine.running) break
  }
  return elapsed
}

describe('order generation & import', () => {
  it('generates the requested batch with lines in range', () => {
    resetOrderSequence()
    const orders = generateOrders(model, { count: 20, minLines: 3, maxLines: 7, arrivalPerMin: 10, seed: 1 })
    expect(orders).toHaveLength(20)
    for (const order of orders) {
      expect(order.lines.length).toBeGreaterThanOrEqual(3)
      expect(order.lines.length).toBeLessThanOrEqual(7)
      // No duplicate locations inside one order.
      expect(new Set(order.lines.map((l) => l.binId)).size).toBe(order.lines.length)
      for (const line of order.lines) expect(model.binsById.has(line.binId)).toBe(true)
    }
  })

  it('releases orders in non-decreasing time order', () => {
    const orders = generateOrders(model, { count: 30, minLines: 2, maxLines: 5, arrivalPerMin: 8, seed: 9 })
    for (let i = 1; i < orders.length; i++) {
      expect(orders[i].releasedAt).toBeGreaterThanOrEqual(orders[i - 1].releasedAt)
    }
  })

  it('skews demand towards fast movers', () => {
    const orders = generateOrders(model, { count: 200, minLines: 4, maxLines: 8, arrivalPerMin: 30, seed: 5 })
    const tally = { fast: 0, medium: 0, slow: 0 }
    for (const o of orders) {
      for (const l of o.lines) tally[model.binsById.get(l.binId)!.sku.velocity]++
    }
    expect(tally.fast).toBeGreaterThan(tally.medium)
    expect(tally.medium).toBeGreaterThan(tally.slow)
  })

  it('resolves the bundled sample wave against the default layout', () => {
    resetOrderSequence()
    // The sample wave is real order data, referencing SKU ids from the same
    // real catalogue `boot()` seeds into the layout — a plain synthetic model
    // (like the shared `model` fixture above) would not contain those ids at
    // all, so this test builds its own model with the catalogue included.
    const realModel = generateWarehouse(config, realCatalogDoc as unknown as CatalogEntry[])
    const { orders, warnings } = importOrders(realModel, sampleOrdersDoc)
    const doc = sampleOrdersDoc as unknown as { orders: { ref: string }[] }
    expect(warnings).toEqual([])
    expect(orders).toHaveLength(doc.orders.length)
    expect(orders[0].ref).toBe(doc.orders[0].ref)
  })

  it('accepts bin ids and SKU ids as well as location codes', () => {
    const bin = model.bins[1234]
    const { orders } = importOrders(model, [
      { ref: 'X1', lines: [{ location: bin.code }, { binId: bin.id }, { sku: bin.sku.id }] },
    ])
    expect(orders[0].lines.every((l) => l.binId === bin.id)).toBe(true)
  })

  it('warns on unresolvable lines instead of throwing', () => {
    const bin = model.bins[10]
    const { orders, warnings } = importOrders(model, [
      { ref: 'X', lines: [{ location: 'NOT-A-BIN' }, { location: bin.code }] },
    ])
    expect(orders[0].lines).toHaveLength(1)
    expect(warnings).toHaveLength(1)
  })

  it('rejects payloads with nothing resolvable', () => {
    expect(() => importOrders(model, [{ ref: 'X', lines: [{ location: 'ZZZ' }] }])).toThrow()
    expect(() => importOrders(model, { nope: true })).toThrow()
  })
})

describe('simulation engine', () => {
  it('starts idle and does nothing until started', () => {
    const engine = new SimulationEngine(model, settings)
    engine.setOrders(generateOrders(model, { count: 5, minLines: 2, maxLines: 4, arrivalPerMin: 60, seed: 2 }))
    engine.advance(1, 1)
    expect(engine.time).toBe(0)
    expect(engine.metrics().ordersCompleted).toBe(0)
    expect(engine.agents.every((a) => a.phase === 'idle')).toBe(true)
  })

  it('completes an entire wave and conserves order count', () => {
    const engine = new SimulationEngine(model, settings)
    const orders = generateOrders(model, { count: 12, minLines: 3, maxLines: 6, arrivalPerMin: 30, seed: 3 })
    engine.setOrders(orders)
    runToCompletion(engine)

    const m = engine.metrics()
    expect(m.ordersCompleted).toBe(orders.length)
    expect(m.ordersPending).toBe(0)
    expect(m.ordersInProgress).toBe(0)
    expect(m.totalPicks).toBe(orders.reduce((s, o) => s + o.lines.length, 0))
    expect(m.totalDistance).toBeGreaterThan(0)
    expect(m.avgOrderTime).toBeGreaterThan(0)
  })

  it('apportions walked distance across the wave without losing any', () => {
    const engine = new SimulationEngine(model, settings)
    const orders = generateOrders(model, { count: 8, minLines: 4, maxLines: 8, arrivalPerMin: 60, seed: 4 })
    engine.setOrders(orders)
    runToCompletion(engine)

    const m = engine.metrics()
    // `recent` keeps the last 8 and this wave is exactly 8 orders, so the
    // per-order shares must add back up to the distance actually walked.
    const apportioned = m.recent.reduce((s, c) => s + c.distance, 0)
    expect(apportioned).toBeCloseTo(m.totalDistance, 3)
    // With re-routing off, pickers walk exactly the route they were given.
    const planned = m.recent.reduce((s, c) => s + c.planned, 0)
    expect(apportioned).toBeCloseTo(planned, 2)
  })

  it('reaches the same result at any integration step size', () => {
    const runWith = (dt: number) => {
      const engine = new SimulationEngine(model, { ...settings, agentCount: 1 })
      engine.setOrders(generateOrders(model, { count: 4, minLines: 3, maxLines: 5, arrivalPerMin: 60, seed: 7 }))
      runToCompletion(engine, 20000, dt)
      return engine.metrics()
    }
    const coarse = runWith(0.2)
    const fine = runWith(0.02)
    expect(coarse.ordersCompleted).toBe(fine.ordersCompleted)
    expect(coarse.totalDistance).toBeCloseTo(fine.totalDistance, 1)
  })

  it('publishes the tour as a task list in visiting order', () => {
    const engine = new SimulationEngine(model, settings)
    const orders = generateOrders(model, { count: 6, minLines: 4, maxLines: 6, arrivalPerMin: 60, seed: 11 })
    engine.setOrders(orders)
    engine.start()
    for (let i = 0; i < 120; i++) engine.step(0.25)

    const working = engine.metrics().agents.find((a) => a.tasks.length > 0)
    expect(working).toBeDefined()
    const tasks = working!.tasks

    // One line per route stop, numbered to match the markers drawn in the scene.
    expect(tasks).toHaveLength(working!.routeStops)
    expect(tasks.map((t) => t.sequence)).toEqual(tasks.map((_, i) => i + 1))
    // Monotonic along the route: the list is the walk, not a re-sort of it.
    for (let i = 1; i < tasks.length; i++) {
      expect(tasks[i].arcLength).toBeGreaterThanOrEqual(tasks[i - 1].arcLength)
    }

    // Exactly one instruction is in hand, and it is the stop after the last done.
    const current = tasks.filter((t) => t.status === 'current')
    expect(current).toHaveLength(1)
    expect(current[0].sequence).toBe(working!.stopsDone + 1)
    expect(tasks.filter((t) => t.status === 'done')).toHaveLength(working!.stopsDone)

    // Every line resolves to a real location, SKU and quantity.
    for (const task of tasks) {
      expect(model.binsById.get(task.binId)?.code).toBe(task.code)
      expect(task.qty).toBeGreaterThan(0)
      expect(task.orderRef).not.toBe('—')
      expect(working!.orderRefs).toContain(task.orderRef)
    }
  })

  it('accounts for every second of the shift in the time split', () => {
    const engine = new SimulationEngine(model, settings)
    engine.setOrders(generateOrders(model, { count: 6, minLines: 3, maxLines: 5, arrivalPerMin: 60, seed: 12 }))
    runToCompletion(engine)

    const m = engine.metrics()
    for (const agent of m.agents) {
      const split = agent.walkTime + agent.pickTime + agent.waitTime + agent.idleTime + agent.breakTime
      // The split is the shift, give or take the unload dwell at the pack bench,
      // which is neither walking nor picking. It must never exceed the clock.
      expect(split).toBeLessThanOrEqual(m.time + 1)
      expect(split).toBeGreaterThan(m.time * 0.5)
      expect(agent.walkTime).toBeGreaterThan(0)
      expect(agent.pickTime).toBeGreaterThan(0)
    }
  })

  it('empties the task list once a tour is finished', () => {
    const engine = new SimulationEngine(model, settings)
    engine.setOrders(generateOrders(model, { count: 4, minLines: 3, maxLines: 4, arrivalPerMin: 60, seed: 13 }))
    runToCompletion(engine)
    expect(engine.metrics().agents.every((a) => a.tasks.length === 0)).toBe(true)
  })

  it('adds and removes pickers without losing work in flight', () => {
    const engine = new SimulationEngine(model, settings)
    const orders = generateOrders(model, { count: 10, minLines: 3, maxLines: 5, arrivalPerMin: 60, seed: 8 })
    engine.setOrders(orders)
    engine.start()
    for (let i = 0; i < 200; i++) engine.step(0.25)

    engine.updateSettings({ agentCount: 1 })
    expect(engine.agents).toHaveLength(1)
    engine.updateSettings({ agentCount: 5 })
    expect(engine.agents).toHaveLength(5)

    runToCompletion(engine)
    expect(engine.metrics().ordersCompleted).toBe(orders.length)
  })

  it('scales the fleet to any size up to the cap, keeping labels unique', () => {
    const engine = new SimulationEngine(model, settings)
    engine.setOrders(generateOrders(model, { count: 40, minLines: 3, maxLines: 6, arrivalPerMin: 600, seed: 81 }))

    for (const n of [1, 7, MAX_AGENTS, 12, 3]) {
      engine.updateSettings({ agentCount: n })
      expect(engine.agents).toHaveLength(n)
      // Labels are the identity past the eighth colour, so they must be unique.
      expect(new Set(engine.agents.map((a) => a.label)).size).toBe(n)
      expect(engine.agents.map((a) => a.label)).toEqual(
        Array.from({ length: n }, (_, i) => `P${i + 1}`),
      )
      expect(engine.metrics().agents).toHaveLength(n)
    }

    // Above the palette the colours cycle rather than inventing new hues.
    engine.updateSettings({ agentCount: MAX_AGENTS })
    const colors = engine.agents.map((a) => a.color)
    expect(new Set(colors).size).toBe(AGENT_COLORS.length)
    expect(colors[0]).toBe(colors[AGENT_COLORS.length])
  })

  it('clamps a request beyond the cap instead of over-spawning', () => {
    const engine = new SimulationEngine(model, settings)
    engine.updateSettings({ agentCount: 999 })
    expect(engine.agents).toHaveLength(MAX_AGENTS)
    engine.updateSettings({ agentCount: 0 })
    expect(engine.agents).toHaveLength(1)
  })

  it('completes a wave with a large fleet without losing orders', () => {
    const engine = new SimulationEngine(model, { ...settings, agentCount: 16 })
    const orders = generateOrders(model, { count: 40, minLines: 3, maxLines: 7, arrivalPerMin: 600, seed: 82 })
    engine.setOrders(orders)
    runToCompletion(engine)
    const m = engine.metrics()
    expect(m.ordersCompleted).toBe(orders.length)
    expect(m.agents).toHaveLength(16)
    expect(m.totalPicks).toBe(orders.reduce((s, o) => s + o.lines.length, 0))
  })

  it('records congestion when several pickers share the floor', () => {
    const engine = new SimulationEngine(model, { ...settings, agentCount: 6, congestionRadius: 4 })
    engine.setOrders(generateOrders(model, { count: 24, minLines: 5, maxLines: 10, arrivalPerMin: 120, seed: 11 }))
    runToCompletion(engine)
    expect(engine.metrics().congestionEvents).toBeGreaterThan(0)
  })

  it('reset clears metrics but keeps the wave', () => {
    const engine = new SimulationEngine(model, settings)
    const orders = generateOrders(model, { count: 6, minLines: 2, maxLines: 4, arrivalPerMin: 60, seed: 12 })
    engine.setOrders(orders)
    runToCompletion(engine)
    expect(engine.metrics().ordersCompleted).toBeGreaterThan(0)

    engine.reset({ keepOrders: true })
    const m = engine.metrics()
    expect(m.time).toBe(0)
    expect(m.ordersCompleted).toBe(0)
    expect(m.totalDistance).toBe(0)
    expect(engine.getOrders()).toHaveLength(orders.length)
  })

  it('will not start with an empty wave', () => {
    const engine = new SimulationEngine(model, settings)
    engine.setOrders([])
    engine.start()
    expect(engine.running).toBe(false)
  })
})

describe('picker embodiments', () => {
  it('each kind has a distinct capacity and pace', () => {
    const kinds = PICKER_KINDS.map((k) => PICKER_PROFILES[k])
    expect(new Set(kinds.map((p) => p.capacityLines)).size).toBe(kinds.length)
    expect(PICKER_PROFILES.palletJack.capacityLines).toBeGreaterThan(PICKER_PROFILES.person.capacityLines)
    expect(PICKER_PROFILES.palletJack.speedFactor).toBeLessThan(PICKER_PROFILES.person.speedFactor)
    expect(PICKER_PROFILES.amr.speedFactor).toBeGreaterThan(1)
  })

  it('a faster embodiment finishes the same wave sooner', () => {
    const runWith = (pickerKind: PickerKind) => {
      const engine = new SimulationEngine(model, { ...settings, pickerKind, agentCount: 2 })
      engine.setOrders(
        generateOrders(model, { count: 8, minLines: 4, maxLines: 6, arrivalPerMin: 120, seed: 21 }),
      )
      runToCompletion(engine)
      return engine.metrics()
    }
    const jack = runWith('palletJack')
    const amr = runWith('amr')
    expect(amr.ordersCompleted).toBe(jack.ordersCompleted)
    expect(amr.time).toBeLessThan(jack.time)
  })

  it('switching embodiment mid-run re-capacities the fleet in place', () => {
    const engine = new SimulationEngine(model, { ...settings, pickerKind: 'person' })
    engine.setOrders(generateOrders(model, { count: 10, minLines: 3, maxLines: 5, arrivalPerMin: 90, seed: 22 }))
    engine.start()
    for (let i = 0; i < 100; i++) engine.step(0.25)

    expect(engine.agents.every((a) => a.kind === 'person')).toBe(true)
    engine.updateSettings({ pickerKind: 'palletJack' })
    expect(engine.agents.every((a) => a.kind === 'palletJack')).toBe(true)
    expect(engine.agents.every((a) => a.capacityLines === PICKER_PROFILES.palletJack.capacityLines)).toBe(true)

    runToCompletion(engine)
    expect(engine.metrics().ordersCompleted).toBe(10)
  })
})

describe('batch picking', () => {
  it('combines nearby orders into one tour within capacity', () => {
    const engine = new SimulationEngine(model, {
      ...settings,
      batchOrders: true,
      agentCount: 1,
      pickerKind: 'palletJack',
    })
    // Many small orders released at once gives the batcher something to work with.
    engine.setOrders(
      generateOrders(model, { count: 20, minLines: 2, maxLines: 3, arrivalPerMin: 600, seed: 31 }),
    )
    runToCompletion(engine)

    const m = engine.metrics()
    expect(m.ordersCompleted).toBe(20)
    expect(m.batchedTours).toBeGreaterThan(0)
    expect(m.avgBatchSize).toBeGreaterThan(1)
    // Never over capacity, and orders sharing a tour share its id.
    for (const c of m.recent) expect(c.batchSize).toBeLessThanOrEqual(4)
    const byTour = new Map<number, number>()
    for (const c of m.recent) byTour.set(c.tourId, (byTour.get(c.tourId) ?? 0) + 1)
    for (const [, count] of byTour) expect(count).toBeLessThanOrEqual(4)
  })

  it('batching cuts total walking for a burst of small orders', () => {
    const wave = () =>
      generateOrders(model, { count: 18, minLines: 2, maxLines: 3, arrivalPerMin: 600, seed: 32 })
    const runWith = (batchOrders: boolean) => {
      const engine = new SimulationEngine(model, { ...settings, batchOrders, agentCount: 1 })
      engine.setOrders(wave())
      runToCompletion(engine)
      return engine.metrics()
    }
    const off = runWith(false)
    const on = runWith(true)
    expect(on.ordersCompleted).toBe(off.ordersCompleted)
    expect(on.totalDistance).toBeLessThan(off.totalDistance)
  })

  it('never loads more lines than the embodiment can carry', () => {
    const engine = new SimulationEngine(model, {
      ...settings,
      batchOrders: true,
      agentCount: 1,
      pickerKind: 'person',
    })
    engine.setOrders(
      generateOrders(model, { count: 24, minLines: 2, maxLines: 4, arrivalPerMin: 600, seed: 33 }),
    )
    engine.start()
    const cap = PICKER_PROFILES.person.capacityLines
    for (let i = 0; i < 4000 && engine.running; i++) {
      engine.step(0.25)
      for (const a of engine.agents) expect(a.linesLoaded).toBeLessThanOrEqual(cap)
    }
  })
})

describe('smart dispatch', () => {
  it('improves SLA attainment over FIFO on a mixed-priority wave', () => {
    const wave = () =>
      generateOrders(model, {
        count: 26,
        minLines: 3,
        maxLines: 7,
        arrivalPerMin: 240,
        seed: 41,
        expressShare: 0.4,
      })
    const runWith = (smartDispatch: boolean) => {
      const engine = new SimulationEngine(model, { ...settings, smartDispatch, agentCount: 3 })
      engine.setOrders(wave())
      runToCompletion(engine)
      return engine.metrics()
    }
    const fifo = runWith(false)
    const smart = runWith(true)
    expect(smart.ordersCompleted).toBe(fifo.ordersCompleted)
    expect(smart.totalDistance).toBeLessThan(fifo.totalDistance)
    expect(smart.onTimeRate).toBeGreaterThanOrEqual(fifo.onTimeRate)
  })

  it('records the reasoning behind each dispatch', () => {
    const engine = new SimulationEngine(model, { ...settings, smartDispatch: true, agentCount: 1 })
    engine.setOrders(generateOrders(model, { count: 6, minLines: 3, maxLines: 5, arrivalPerMin: 600, seed: 42 }))
    engine.start()
    for (let i = 0; i < 60; i++) engine.step(0.25)

    const thoughts = engine.agents[0].thoughts
    expect(thoughts.length).toBeGreaterThan(0)
    expect(thoughts.some((t) => t.kind === 'dispatch')).toBe(true)
    expect(thoughts.some((t) => t.kind === 'plan')).toBe(true)
    // The dispatch rationale must carry actual numbers, not a bare label.
    expect(thoughts.find((t) => t.kind === 'dispatch')!.text).toMatch(/m away/)
  })
})

describe('congestion re-routing', () => {
  it('re-plans around a blocked aisle and walks further than planned', () => {
    const engine = new SimulationEngine(model, {
      ...settings,
      rerouting: true,
      agentCount: 6,
      congestionRadius: 5,
    })
    engine.setOrders(
      generateOrders(model, { count: 30, minLines: 6, maxLines: 12, arrivalPerMin: 600, seed: 51 }),
    )
    runToCompletion(engine)

    const m = engine.metrics()
    expect(m.ordersCompleted).toBe(30)
    expect(m.reroutes).toBeGreaterThan(0)
    // Re-routing costs real distance, and planned-vs-actual must capture it
    // like-for-like: both sides cover completed tours only.
    expect(m.totalActual).toBeGreaterThan(m.totalPlanned)
    expect(m.totalActual).toBeLessThan(m.totalPlanned * 2)
    expect(m.totalActual).toBeCloseTo(m.totalDistance, 3)
  })

  it('completes the wave even when re-routing is disabled', () => {
    const engine = new SimulationEngine(model, { ...settings, rerouting: false, agentCount: 6 })
    engine.setOrders(
      generateOrders(model, { count: 20, minLines: 5, maxLines: 9, arrivalPerMin: 600, seed: 52 }),
    )
    runToCompletion(engine)
    expect(engine.metrics().ordersCompleted).toBe(20)
    expect(engine.metrics().reroutes).toBe(0)
  })
})

describe('stock depletion', () => {
  it('draws down on-hand levels and flags replenishment', () => {
    const engine = new SimulationEngine(model, { ...settings, stockDepletion: true })
    const orders = generateOrders(model, { count: 20, minLines: 5, maxLines: 9, arrivalPerMin: 600, seed: 61 })
    engine.setOrders(orders)

    const before = model.bins.reduce((s, b) => s + b.sku.stock, 0)
    runToCompletion(engine)
    const after = model.bins.reduce((s, b) => s + b.sku.stock, 0)

    const unitsPicked = orders.reduce((s, o) => s + o.lines.reduce((t, l) => t + l.qty, 0), 0)
    expect(after).toBeLessThan(before)
    expect(before - after).toBe(unitsPicked)
  })

  it('restores on-hand levels on reset so runs stay comparable', () => {
    const engine = new SimulationEngine(model, { ...settings, stockDepletion: true })
    engine.setOrders(generateOrders(model, { count: 12, minLines: 4, maxLines: 8, arrivalPerMin: 600, seed: 62 }))
    const opening = model.bins.reduce((s, b) => s + b.sku.stockInitial, 0)
    runToCompletion(engine)
    expect(model.bins.reduce((s, b) => s + b.sku.stock, 0)).toBeLessThan(opening)

    engine.reset({ keepOrders: true })
    expect(model.bins.reduce((s, b) => s + b.sku.stock, 0)).toBe(opening)
    expect(engine.metrics().replenAlerts).toBe(0)
  })

  it('leaves stock untouched when depletion is off', () => {
    engine_reset()
    const engine = new SimulationEngine(model, { ...settings, stockDepletion: false })
    engine.setOrders(generateOrders(model, { count: 10, minLines: 4, maxLines: 8, arrivalPerMin: 600, seed: 63 }))
    const before = model.bins.reduce((s, b) => s + b.sku.stock, 0)
    runToCompletion(engine)
    expect(model.bins.reduce((s, b) => s + b.sku.stock, 0)).toBe(before)
    expect(engine.metrics().shortPicks).toBe(0)
  })
})

describe('SLA and breaks', () => {
  it('gives express orders a tighter due time than standard', () => {
    expect(slaFor({ priority: 'express', releasedAt: 0 })).toBeLessThan(
      slaFor({ priority: 'standard', releasedAt: 0 }),
    )
    const orders = generateOrders(model, { count: 30, minLines: 2, maxLines: 5, arrivalPerMin: 60, seed: 71 })
    for (const o of orders) expect(o.dueAt).toBe(slaFor(o))
  })

  it('marks orders packed past their SLA as late', () => {
    // One picker, a big simultaneous burst — some orders must miss their window.
    const engine = new SimulationEngine(model, { ...settings, agentCount: 1 })
    engine.setOrders(
      generateOrders(model, { count: 26, minLines: 6, maxLines: 10, arrivalPerMin: 600, seed: 72 }),
    )
    runToCompletion(engine)
    const m = engine.metrics()
    expect(m.ordersLate).toBeGreaterThan(0)
    expect(m.onTimeRate).toBeLessThan(1)
    expect(m.onTimeRate).toBeGreaterThanOrEqual(0)
  })

  it('sends pickers on scheduled breaks over a long shift', () => {
    const engine = new SimulationEngine(model, { ...settings, restBreaks: true, agentCount: 2 })
    engine.setOrders(
      generateOrders(model, { count: 60, minLines: 4, maxLines: 8, arrivalPerMin: 4, seed: 73 }),
    )
    engine.start()
    let sawBreak = false
    for (let i = 0; i < 40000 && engine.running; i++) {
      engine.step(0.5)
      if (engine.agents.some((a) => a.phase === 'break')) sawBreak = true
    }
    expect(sawBreak).toBe(true)
  })
})

describe('pack-out & dispatch', () => {
  it('turns every picked order into a parcel and ships it', () => {
    const engine = new SimulationEngine(model, settings)
    const orders = generateOrders(model, { count: 8, minLines: 3, maxLines: 6, arrivalPerMin: 120, seed: 91 })
    engine.setOrders(orders)
    runToCompletion(engine)

    const m = engine.metrics()
    expect(m.ordersPicked).toBe(orders.length)
    expect(m.parcelsPacked).toBe(orders.length)
    expect(m.ordersCompleted).toBe(orders.length)
    // Cartonisation never produces fewer cartons than parcels.
    expect(m.cartonsPacked).toBeGreaterThanOrEqual(m.parcelsPacked)
    // The wave drains through the docks: nothing left on a bench, a belt or a bay.
    expect(m.ordersAwaitingPack).toBe(0)
    expect(m.ordersPacking).toBe(0)
    expect(m.parcelsInTransit).toBe(0)
    expect(m.parcelsStaged).toBe(0)
    expect(m.parcelsDispatched).toBe(orders.length)
    expect(m.trailersSealed).toBeGreaterThan(0)
    expect(m.docks.reduce((s, d) => s + d.dispatched, 0)).toBe(orders.length)
  })

  it('reports the whole lifecycle, not just the walking', () => {
    const engine = new SimulationEngine(model, settings)
    engine.setOrders(generateOrders(model, { count: 6, minLines: 3, maxLines: 6, arrivalPerMin: 120, seed: 92 }))
    runToCompletion(engine)

    const m = engine.metrics()
    expect(m.avgPackSec).toBeGreaterThan(0)
    expect(m.avgConveySec).toBeGreaterThan(0)
    for (const c of m.recent) {
      expect(c.packSeconds).toBeGreaterThan(0)
      expect(c.conveySeconds).toBeGreaterThan(0)
      expect(c.cartons).toBeGreaterThanOrEqual(1)
      expect(c.packStation).toMatch(/^Pack /)
      expect(c.dock).toMatch(/^Dock /)
      // Queue time at induction is the remainder, so the parts can only under-fill.
      expect(c.pickSeconds + c.packSeconds + c.conveySeconds).toBeLessThanOrEqual(c.duration + 1e-6)
      // An order is not done until it is on the dock, so it outlives its pick.
      expect(c.duration).toBeGreaterThan(c.pickSeconds)
    }
  })

  it('sorts every channel to its own door', () => {
    const engine = new SimulationEngine(model, settings)
    const orders = generateOrders(model, { count: 8, minLines: 2, maxLines: 4, arrivalPerMin: 600, seed: 93 })
    engine.setOrders(orders)
    runToCompletion(engine)

    const channelOf = new Map(orders.map((o) => [o.ref, o.channel]))
    const doorFor = new Map<string, string>()
    for (const c of engine.metrics().recent) {
      const channel = channelOf.get(c.ref)!
      const seen = doorFor.get(channel)
      if (seen) expect(c.dock).toBe(seen)
      else doorFor.set(channel, c.dock)
    }
    expect(doorFor.size).toBeGreaterThan(1)
  })

  it('an under-staffed pack wall becomes the bottleneck', () => {
    const wave = () =>
      generateOrders(model, { count: 18, minLines: 4, maxLines: 8, arrivalPerMin: 600, seed: 94 })
    const runWith = (packStaff: number) => {
      const engine = new SimulationEngine(model, { ...settings, packStaff, agentCount: 4 })
      engine.setOrders(wave())
      runToCompletion(engine)
      return engine.metrics()
    }
    const thin = runWith(1)
    const full = runWith(3)

    expect(thin.ordersCompleted).toBe(full.ordersCompleted)
    expect(thin.time).toBeGreaterThan(full.time)
    // One bench doing all the work is busier and forms a queue behind it.
    expect(thin.packUtilisation).toBeGreaterThan(full.packUtilisation)
    expect(thin.packBufferPeak).toBeGreaterThan(full.packBufferPeak)
  })

  it('a full induction buffer pushes back on the pickers', () => {
    const engine = new SimulationEngine(model, {
      ...settings,
      packStaff: 1,
      packBufferLimit: 1,
      agentCount: 5,
    })
    engine.setOrders(
      generateOrders(model, { count: 16, minLines: 2, maxLines: 4, arrivalPerMin: 600, seed: 95 }),
    )
    engine.start()
    let sawHold = false
    for (let i = 0; i < 20000 && engine.running; i++) {
      engine.step(0.25)
      if (engine.agents.some((a) => a.phase === 'awaitPack')) sawHold = true
    }
    expect(sawHold).toBe(true)
    const m = engine.metrics()
    expect(m.packWaitSeconds).toBeGreaterThan(0)
    // Back-pressure must not lose work: everything still ships.
    expect(m.ordersCompleted).toBe(16)
  })

  it('belt speed changes how long transit takes', () => {
    const runWith = (conveyorSpeed: number) => {
      const engine = new SimulationEngine(model, { ...settings, conveyorSpeed })
      engine.setOrders(generateOrders(model, { count: 6, minLines: 3, maxLines: 5, arrivalPerMin: 600, seed: 96 }))
      runToCompletion(engine)
      return engine.metrics()
    }
    const slow = runWith(0.4)
    const quick = runWith(1.6)
    expect(slow.ordersCompleted).toBe(quick.ordersCompleted)
    expect(slow.avgConveySec).toBeGreaterThan(quick.avgConveySec * 1.5)
  })

  it('still dispatches with conveyor sortation switched off', () => {
    const engine = new SimulationEngine(model, { ...settings, conveyorSortation: false })
    const orders = generateOrders(model, { count: 8, minLines: 3, maxLines: 5, arrivalPerMin: 600, seed: 97 })
    engine.setOrders(orders)
    runToCompletion(engine)

    const m = engine.metrics()
    expect(m.ordersCompleted).toBe(orders.length)
    // Hand-trucked parcels never merge onto a belt, so nothing can be held there.
    expect(m.mergeBlocks).toBe(0)
    expect(m.avgConveySec).toBeGreaterThan(0)
  })

  it('reset clears the pack line as well as the floor', () => {
    const engine = new SimulationEngine(model, settings)
    engine.setOrders(generateOrders(model, { count: 6, minLines: 3, maxLines: 5, arrivalPerMin: 600, seed: 98 }))
    runToCompletion(engine)
    expect(engine.metrics().parcelsPacked).toBeGreaterThan(0)

    engine.reset({ keepOrders: true })
    const m = engine.metrics()
    expect(m.parcelsPacked).toBe(0)
    expect(m.parcelsDispatched).toBe(0)
    expect(m.ordersPicked).toBe(0)
    expect(m.parcels).toHaveLength(0)
    expect(m.packStations.every((s) => s.ordersPacked === 0)).toBe(true)
    expect(m.docks.every((d) => d.dispatched === 0 && d.staged === 0)).toBe(true)
  })
})

/** Guard against cross-test stock bleed, since the model is module-scoped. */
function engine_reset() {
  for (const bin of model.bins) bin.sku.stock = bin.sku.stockInitial
}

describe('strategy comparison', () => {
  it('scores every strategy on the same workload', () => {
    const engine = new SimulationEngine(model, settings)
    const orders = generateOrders(model, { count: 15, minLines: 4, maxLines: 9, arrivalPerMin: 20, seed: 13 })
    const rows = compareStrategies(model, engine.routingContext, orders, settings)

    expect(rows).toHaveLength(3)
    const lines = orders.reduce((s, o) => s + o.lines.length, 0)
    for (const row of rows) {
      expect(row.orders).toBe(orders.length)
      expect(row.lines).toBe(lines)
      expect(row.totalDistance).toBeGreaterThan(0)
      // Pick time depends only on the lines, never on the route.
      expect(row.totalPickTimeSec).toBeCloseTo(rows[0].totalPickTimeSec, 6)
      expect(row.estTotalTimeSec).toBeGreaterThan(row.totalWalkTimeSec)
    }

    const tsp = rows.find((r) => r.strategyId === 'tsp-2opt')!
    const sShape = rows.find((r) => r.strategyId === 'serpentine')!
    expect(tsp.totalDistance).toBeLessThan(sShape.totalDistance)
    expect(tsp.estOrdersPerPickerHour).toBeGreaterThan(sShape.estOrdersPerPickerHour)
  })
})
