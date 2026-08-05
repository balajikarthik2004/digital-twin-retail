import { describe, expect, it } from 'vitest'
import layoutsDoc from '../data/layouts.json'
import { createRoutingContext } from '../pathfinding/route'
import { generateWarehouse } from '../warehouse/generate'
import type { WarehouseConfig } from '../warehouse/types'
import { planPutaway } from './plan'
import { createManualReceipt, resetReceiptSequence } from './receipts'
import { PutawayWalker } from './walker'

const config = (layoutsDoc as unknown as { layouts: WarehouseConfig[] }).layouts.find(
  (c) => c.id === 'dc-north',
)!

function aPlan() {
  const model = generateWarehouse(config)
  const ctx = createRoutingContext(model.graph)
  resetReceiptSequence()
  const receipt = createManualReceipt({
    name: 'Walker Test Line',
    skuId: null,
    category: 'Pantry',
    velocity: 'medium',
    qty: 40,
    unitVolume: 2,
  })
  return { model, plan: planPutaway(model, ctx, receipt, receipt.lines[0])! }
}

/** Run the walker to completion, guarding against a state machine that stalls. */
function run(walker: PutawayWalker, dt = 0.25, maxSteps = 20_000) {
  let steps = 0
  while (walker.state.phase !== 'done' && steps++ < maxSteps) walker.advance(dt)
  return steps
}

describe('putaway walker', () => {
  it('walks out, places, and comes back', () => {
    const { plan } = aPlan()
    const seen: string[] = []
    let arrived = 0
    let finished = 0

    const walker = new PutawayWalker(plan.route, {
      speed: 1,
      handleSec: 4,
      onArrive: () => arrived++,
      onFinish: () => finished++,
    })

    while (walker.state.phase !== 'done') {
      walker.advance(0.25)
      const phase = walker.state.phase
      if (seen[seen.length - 1] !== phase) seen.push(phase)
    }

    expect(seen).toEqual(['walking', 'placing', 'returning', 'done'])
    // Each side effect fires exactly once, however many frames it took.
    expect(arrived).toBe(1)
    expect(finished).toBe(1)
  })

  it('starts at goods-in and reaches the shelf before the stock lands', () => {
    const { model, plan } = aPlan()
    const receiving = model.graph.nodes.get(model.receiving)!.pos
    const bin = model.binsById.get(plan.chosenBinId)!

    let posAtArrival = { x: 0, y: 0 }
    const walker = new PutawayWalker(plan.route, {
      speed: 1.2,
      handleSec: 3,
      onArrive: () => {
        posAtArrival = { ...walker.state.pos }
      },
      onFinish: () => {},
    })

    const start = walker.state.pos
    expect(start.x).toBeCloseTo(receiving.x, 4)
    expect(start.y).toBeCloseTo(receiving.y, 4)

    run(walker)

    // The stock lands at the bin's pick point, not somewhere along the way.
    expect(posAtArrival.x).toBeCloseTo(bin.pickPoint.x, 4)
    expect(posAtArrival.y).toBeCloseTo(bin.pickPoint.y, 4)
    // And the operator ends up back where they started.
    expect(walker.state.pos.x).toBeCloseTo(receiving.x, 4)
    expect(walker.state.pos.y).toBeCloseTo(receiving.y, 4)
  })

  it('never overshoots the route in either direction', () => {
    const { plan } = aPlan()
    const walker = new PutawayWalker(plan.route, {
      speed: 40, // absurd pace: a single tick would blow past the end
      handleSec: 1,
      onArrive: () => {},
      onFinish: () => {},
    })

    while (walker.state.phase !== 'done') {
      walker.advance(1)
      const p = walker.state.progress
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThanOrEqual(1)
    }
    // Out and back, so at least the route length twice over.
    expect(walker.state.distance).toBeGreaterThanOrEqual(plan.route.distance * 2 - 1e-6)
  })

  it('finishNow lands the stock without walking it', () => {
    const { plan } = aPlan()
    let arrived = 0
    let finished = 0
    const walker = new PutawayWalker(plan.route, {
      speed: 1,
      handleSec: 30,
      onArrive: () => arrived++,
      onFinish: () => finished++,
    })

    walker.advance(0.5)
    walker.finishNow()
    expect(walker.state.phase).toBe('done')
    expect(arrived).toBe(1)
    expect(finished).toBe(1)

    // Ticking a finished walker is inert — no duplicate stock.
    walker.advance(10)
    expect(arrived).toBe(1)
    expect(finished).toBe(1)
  })
})
