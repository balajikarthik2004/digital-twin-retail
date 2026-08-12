import { ShortestPathOracle, dist2 } from './graph'
import type {
  NavGraph,
  NodeId,
  Route,
  RouteStop,
  RouteWaypoint,
  RoutingContext,
  RoutingStrategy,
} from './types'

/** Wrap a graph into the read-only view handed to strategies. */
export function createRoutingContext(graph: NavGraph, oracle = new ShortestPathOracle(graph)): RoutingContext {
  return {
    graph,
    distance: (a, b) => oracle.distance(a, b),
    path: (a, b) => oracle.path(a, b),
    node: (id) => {
      const n = graph.nodes.get(id)
      if (!n) throw new Error(`Unknown nav node: ${id}`)
      return n
    },
  }
}

/**
 * Turn a strategy's visiting order into a concrete walkable route.
 *
 * This is the single place that stitches shortest paths together, measures arc
 * length and projects stops onto the polyline — which is why a new strategy
 * never has to touch geometry or rendering.
 */
export function buildRoute(
  ctx: RoutingContext,
  strategy: RoutingStrategy,
  stops: RouteStop[],
  start: NodeId,
  end: NodeId = start,
): Route {
  const ordered = stops.length > 0 ? strategy.sequence(ctx, stops, start, end) : []

  const nodePath: NodeId[] = [start]
  // Stops that land on the node the picker is already standing on (same aisle
  // bay, different shelf level) must still be recorded, so we track by index.
  const stopAtPathIndex: { index: number; stop: RouteStop }[] = []

  let cursor = start
  for (const stop of ordered) {
    if (stop.node !== cursor) {
      const leg = ctx.path(cursor, stop.node)
      if (leg.length === 0) {
        // Unreachable stop: skip it rather than corrupting the whole route.
        continue
      }
      for (let i = 1; i < leg.length; i++) nodePath.push(leg[i])
      cursor = stop.node
    }
    stopAtPathIndex.push({ index: nodePath.length - 1, stop })
  }

  if (cursor !== end) {
    const back = ctx.path(cursor, end)
    for (let i = 1; i < back.length; i++) nodePath.push(back[i])
  }

  const polyline = nodePath.map((id) => ctx.node(id).pos)
  const elevations = nodePath.map((id) => ctx.node(id).elevation ?? 0)
  const cumulative = new Array<number>(polyline.length)
  cumulative[0] = 0
  for (let i = 1; i < polyline.length; i++) {
    cumulative[i] = cumulative[i - 1] + dist2(polyline[i - 1], polyline[i])
  }

  const waypoints: RouteWaypoint[] = stopAtPathIndex.map((entry, i) => ({
    stop: entry.stop,
    pointIndex: entry.index,
    arcLength: cumulative[entry.index],
    sequence: i + 1,
  }))

  return {
    strategyId: strategy.id,
    nodePath,
    polyline,
    elevations,
    cumulative,
    waypoints,
    distance: cumulative[cumulative.length - 1] ?? 0,
    serviceTime: stops.reduce((sum, s) => sum + s.serviceTime, 0),
  }
}

/** Total tour length for a candidate ordering, including the return leg. */
export function tourLength(
  ctx: RoutingContext,
  order: RouteStop[],
  start: NodeId,
  end: NodeId,
): number {
  if (order.length === 0) return ctx.distance(start, end)
  let total = ctx.distance(start, order[0].node)
  for (let i = 1; i < order.length; i++) {
    total += ctx.distance(order[i - 1].node, order[i].node)
  }
  return total + ctx.distance(order[order.length - 1].node, end)
}
