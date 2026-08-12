import { describe, expect, it } from 'vitest'
import layoutsDoc from '../data/layouts.json'
import { generateWarehouse } from '../warehouse/generate'
import { RESERVE_LEVELS, isReserveLevel } from '../warehouse/rackGeometry'
import type { WarehouseConfig } from '../warehouse/types'
import { NavGraphBuilder, ShortestPathOracle, dijkstra } from './graph'
import { buildRoute, createRoutingContext, tourLength } from './route'
import { ROUTING_STRATEGIES, getStrategy, nearestNeighbour, serpentine, tspTwoOpt } from './strategies'
import type { RouteStop } from './types'

const configs = (layoutsDoc as unknown as { layouts: WarehouseConfig[] }).layouts
const config = configs.find((c) => c.id === 'dc-north')!
const model = generateWarehouse(config)
const ctx = createRoutingContext(model.graph, new ShortestPathOracle(model.graph))

/** Deterministic pick list spread across aisles and blocks. */
function pickList(count: number, stride = 137): RouteStop[] {
  const stops: RouteStop[] = []
  const seen = new Set<string>()
  for (let i = 0; i < count; i++) {
    const bin = model.bins[(i * stride) % model.bins.length]
    if (seen.has(bin.node)) continue
    seen.add(bin.node)
    stops.push({ node: bin.node, ref: bin.id, serviceTime: 10 })
  }
  return stops
}

describe('graph', () => {
  it('finds the shortest path in a hand-built graph', () => {
    const g = new NavGraphBuilder()
    g.addNode({ id: 'a', pos: { x: 0, y: 0 }, kind: 'cross' })
    g.addNode({ id: 'b', pos: { x: 10, y: 0 }, kind: 'cross' })
    g.addNode({ id: 'c', pos: { x: 0, y: 3 }, kind: 'cross' })
    g.addNode({ id: 'd', pos: { x: 10, y: 3 }, kind: 'cross' })
    g.link('a', 'b') // 10
    g.link('a', 'c') // 3
    g.link('c', 'd') // 10
    g.link('b', 'd') // 3

    const oracle = new ShortestPathOracle(g.build())
    expect(oracle.distance('a', 'd')).toBeCloseTo(13, 6)
    expect(oracle.path('a', 'd')).toHaveLength(3)
    expect(oracle.distance('a', 'a')).toBe(0)
  })

  it('reports unreachable nodes as Infinity', () => {
    const g = new NavGraphBuilder()
    g.addNode({ id: 'a', pos: { x: 0, y: 0 }, kind: 'cross' })
    g.addNode({ id: 'island', pos: { x: 99, y: 99 }, kind: 'cross' })
    const oracle = new ShortestPathOracle(g.build())
    expect(oracle.distance('a', 'island')).toBe(Infinity)
    expect(oracle.path('a', 'island')).toEqual([])
  })

  it('keeps every warehouse node reachable from the depot', () => {
    const { dist } = dijkstra(model.graph, model.depot)
    expect(dist.size).toBe(model.graph.nodes.size)
  })

  it('routes between adjacent aisles via a cross aisle, not through racking', () => {
    // Two bins in neighbouring aisles at the same depth: the walk must be much
    // longer than the straight-line gap, because racking blocks the direct path.
    const a = model.bins.find((b) => b.aisle === 0 && b.bay === 5)!
    const b = model.bins.find((x) => x.aisle === 1 && x.bay === 5)!
    const straight = Math.hypot(a.pickPoint.x - b.pickPoint.x, a.pickPoint.y - b.pickPoint.y)
    const walked = ctx.distance(a.node, b.node)
    expect(walked).toBeGreaterThan(straight * 2)
  })
})

describe('route building', () => {
  it('returns a closed tour that starts and ends at the depot', () => {
    const stops = pickList(8)
    const route = buildRoute(ctx, tspTwoOpt, stops, model.depot)
    expect(route.nodePath[0]).toBe(model.depot)
    expect(route.nodePath[route.nodePath.length - 1]).toBe(model.depot)
    expect(route.waypoints).toHaveLength(stops.length)
    expect(route.distance).toBeGreaterThan(0)
  })

  it('produces a monotonically increasing arc length matching the polyline', () => {
    const route = buildRoute(ctx, serpentine, pickList(12), model.depot)
    expect(route.cumulative).toHaveLength(route.polyline.length)
    expect(route.cumulative[0]).toBe(0)
    for (let i = 1; i < route.cumulative.length; i++) {
      expect(route.cumulative[i]).toBeGreaterThanOrEqual(route.cumulative[i - 1])
    }
    expect(route.cumulative[route.cumulative.length - 1]).toBeCloseTo(route.distance, 6)
  })

  it('records waypoints in visiting order at the right arc lengths', () => {
    const route = buildRoute(ctx, nearestNeighbour, pickList(10), model.depot)
    route.waypoints.forEach((wp, i) => {
      expect(wp.sequence).toBe(i + 1)
      expect(wp.arcLength).toBeCloseTo(route.cumulative[wp.pointIndex], 6)
      if (i > 0) expect(wp.arcLength).toBeGreaterThanOrEqual(route.waypoints[i - 1].arcLength)
    })
  })

  it('keeps every line of a multi-level pick, even when stops share a node', () => {
    // Three bins in the same bay at different levels resolve to one nav node.
    const bay = model.bins.filter((b) => b.aisle === 2 && b.side === 'L' && b.bay === 3).slice(0, 3)
    expect(new Set(bay.map((b) => b.node)).size).toBe(1)
    const stops: RouteStop[] = bay.map((b) => ({ node: b.node, ref: b.id, serviceTime: 5 }))
    const route = buildRoute(ctx, tspTwoOpt, stops, model.depot)
    expect(route.waypoints).toHaveLength(3)
    expect(route.serviceTime).toBe(15)
  })

  it('handles an empty pick list without producing a bogus path', () => {
    const route = buildRoute(ctx, tspTwoOpt, [], model.depot)
    expect(route.waypoints).toHaveLength(0)
    expect(route.distance).toBe(0)
  })

  it('visits a single stop and comes back', () => {
    const bin = model.bins[500]
    const route = buildRoute(ctx, serpentine, [{ node: bin.node, ref: bin.id, serviceTime: 8 }], model.depot)
    expect(route.waypoints).toHaveLength(1)
    expect(route.distance).toBeGreaterThan(ctx.distance(model.depot, bin.node))
  })
})

describe('routing strategies', () => {
  it('every registered strategy is a permutation of the input stops', () => {
    const stops = pickList(14)
    for (const strategy of ROUTING_STRATEGIES) {
      const ordered = strategy.sequence(ctx, stops, model.depot, model.depot)
      expect(ordered).toHaveLength(stops.length)
      expect(new Set(ordered.map((s) => s.ref))).toEqual(new Set(stops.map((s) => s.ref)))
    }
  })

  it('exposes strategies by id and rejects unknown ids', () => {
    expect(getStrategy('tsp-2opt')).toBe(tspTwoOpt)
    expect(() => getStrategy('nope')).toThrow()
  })

  it('serpentine sweeps aisles in ascending order', () => {
    const stops = pickList(18)
    const ordered = serpentine.sequence(ctx, stops, model.depot, model.depot)
    const aisleRun = ordered
      .map((s) => ctx.node(s.node).aisle!)
      .filter((a, i, arr) => i === 0 || a !== arr[i - 1])
    expect(aisleRun).toEqual([...aisleRun].sort((a, b) => a - b))
    // Each aisle is entered exactly once — that is the point of an S-shape.
    expect(new Set(aisleRun).size).toBe(aisleRun.length)
  })

  it('serpentine alternates direction between consecutive aisles', () => {
    const stops = pickList(24, 61)
    const ordered = serpentine.sequence(ctx, stops, model.depot, model.depot)
    const byAisle = new Map<number, number[]>()
    ordered.forEach((s) => {
      const node = ctx.node(s.node)
      const list = byAisle.get(node.aisle!) ?? []
      list.push(node.pos.y)
      byAisle.set(node.aisle!, list)
    })
    const directions = [...byAisle.entries()]
      .filter(([, depths]) => depths.length > 1)
      .sort((a, b) => a[0] - b[0])
      .map(([, depths]) => (depths[depths.length - 1] > depths[0] ? 1 : -1))
    for (let i = 1; i < directions.length; i++) {
      expect(directions[i]).toBe(-directions[i - 1])
    }
  })

  it('2-opt never returns a longer tour than the greedy tour it starts from', () => {
    for (const size of [6, 12, 20, 30]) {
      const stops = pickList(size, 89)
      const greedy = nearestNeighbour.sequence(ctx, stops, model.depot, model.depot)
      const refined = tspTwoOpt.sequence(ctx, stops, model.depot, model.depot)
      expect(tourLength(ctx, refined, model.depot, model.depot)).toBeLessThanOrEqual(
        tourLength(ctx, greedy, model.depot, model.depot) + 1e-6,
      )
    }
  })

  it('beats the S-shape baseline on total distance for a realistic pick list', () => {
    const stops = pickList(16, 211)
    const distanceFor = (id: string) =>
      buildRoute(ctx, getStrategy(id), stops, model.depot).distance

    const sShape = distanceFor('serpentine')
    const greedy = distanceFor('nearest-neighbour')
    const tsp = distanceFor('tsp-2opt')

    expect(tsp).toBeLessThan(sShape)
    expect(tsp).toBeLessThanOrEqual(greedy + 1e-6)
  })
})

describe('warehouse generation', () => {
  it('derives geometry and slotting from the config', () => {
    const bays = config.aisles * 2 * config.blocks * config.baysPerBlock
    // Every bay carries `levels * slotsPerBay` case-pick slots on the pick
    // face, plus one full-width pallet position per reserve level above it.
    const expectedBins = bays * (config.levels * config.slotsPerBay + RESERVE_LEVELS)
    expect(model.bins).toHaveLength(expectedBins)
    expect(model.racks).toHaveLength(config.aisles * 2 * config.blocks)
    expect(model.aisleX).toHaveLength(config.aisles)
    expect(model.crossZ).toHaveLength(config.blocks + 1)
    expect(model.facilities.filter((f) => f.kind === 'dock')).toHaveLength(config.dockDoors)
    expect(model.facilities.filter((f) => f.kind === 'pack')).toHaveLength(config.packStations)
  })

  it('routes a reserve location over the mezzanine, not the aisle below it', () => {
    /*
     * Bulk is worked from the walkway at the foot of the reserve tier, so its
     * node sits directly above the bay's — same plan position, a storey up,
     * and reachable only by a staircase. That separation is the whole reason a
     * bulk trip costs what it does; if the two ever collapsed back onto one
     * node, every reserve pick would silently become free.
     */
    const reserve = model.bins.find((b) => isReserveLevel(config, b.level))!
    const below = model.bins.find(
      (b) => b.aisle === reserve.aisle && b.side === reserve.side && b.bay === reserve.bay && b.level === 0,
    )!
    expect(reserve.node).not.toBe(below.node)

    const up = model.graph.nodes.get(reserve.node)!
    const down = model.graph.nodes.get(below.node)!
    expect(up.pos).toEqual(down.pos)
    expect(up.elevation ?? 0).toBeGreaterThan(down.elevation ?? 0)
    expect(reserve.face.y).toBeGreaterThan(below.face.y)
  })

  it('makes the staircase the only way onto the mezzanine', () => {
    // Every mezzanine node must be reachable, and the walk to one must cost
    // more than the walk to the bay underneath it — that difference IS the
    // climb. If a stray edge ever linked the two levels directly, bulk would
    // quietly become as cheap as the pick face.
    const reserve = model.bins.find(
      (b) => isReserveLevel(config, b.level) && b.aisle === model.config.aisles - 1,
    )!
    const below = model.bins.find(
      (b) => b.aisle === reserve.aisle && b.side === reserve.side && b.bay === reserve.bay && b.level === 0,
    )!
    const toBulk = ctx.distance(model.depot, reserve.node)
    const toFace = ctx.distance(model.depot, below.node)
    expect(Number.isFinite(toBulk)).toBe(true)
    expect(toBulk).toBeGreaterThan(toFace)
  })

  it('emits every pick-face location before any reserve location', () => {
    // `buildWarehouse` trims `InstancedMesh.count` to hide bulk stock in a
    // plan view, which only works while the reserve bins are a contiguous
    // tail of the array.
    const firstReserve = model.bins.findIndex((b) => isReserveLevel(config, b.level))
    expect(firstReserve).toBeGreaterThan(0)
    expect(model.bins.slice(firstReserve).every((b) => isReserveLevel(config, b.level))).toBe(true)
  })

  it('keeps fast movers off the reserve tier', () => {
    // Bulk is long-tail stock by construction — a fast mover up there would
    // mean the busiest lines were the most expensive ones to reach.
    const reserveBins = model.bins.filter((b) => isReserveLevel(config, b.level))
    expect(reserveBins.length).toBeGreaterThan(0)
    expect(reserveBins.some((b) => b.sku.velocity === 'fast')).toBe(false)
  })

  it('gives a bulk position more capacity than a case-pick slot', () => {
    const avg = (bins: typeof model.bins) => bins.reduce((t, b) => t + b.capacity, 0) / bins.length
    const reserveAvg = avg(model.bins.filter((b) => isReserveLevel(config, b.level)))
    const faceAvg = avg(model.bins.filter((b) => !isReserveLevel(config, b.level)))
    expect(reserveAvg).toBeGreaterThan(faceAvg)
  })

  it('is deterministic for a given seed', () => {
    const again = generateWarehouse(config)
    expect(again.bins).toHaveLength(model.bins.length)
    expect(again.bins[0].sku).toEqual(model.bins[0].sku)
    const last = model.bins.length - 1
    expect(again.bins[last].sku.name).toBe(model.bins[last].sku.name)
    expect(again.bins.map((b) => b.sku.velocity)).toEqual(model.bins.map((b) => b.sku.velocity))
  })

  it('slots fast movers nearer the front than slow movers', () => {
    const avgDepth = (tier: string) => {
      const subset = model.bins.filter((b) => b.sku.velocity === tier)
      return subset.reduce((s, b) => s + b.face.z, 0) / subset.length
    }
    expect(avgDepth('fast')).toBeLessThan(avgDepth('slow'))
  })

  it('gives every bin a pick point inside its own aisle', () => {
    for (const bin of model.bins.filter((_, i) => i % 97 === 0)) {
      expect(bin.pickPoint.x).toBeCloseTo(model.aisleX[bin.aisle], 6)
      expect(model.graph.nodes.has(bin.node)).toBe(true)
    }
  })

  it('generates every configured layout preset', () => {
    for (const preset of configs) {
      const built = generateWarehouse(preset)
      expect(built.bins.length).toBeGreaterThan(0)
      const { dist } = dijkstra(built.graph, built.depot)
      expect(dist.size).toBe(built.graph.nodes.size)
    }
  })
})
