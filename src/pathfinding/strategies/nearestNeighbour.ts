import type { NodeId, RouteStop, RoutingContext, RoutingStrategy } from '../types'

/**
 * Greedy nearest-neighbour: repeatedly walk to the closest unvisited stop,
 * measured by true graph distance (not straight-line), so racks are respected.
 *
 * Fast and usually well ahead of S-shape, but it strands isolated stops and
 * pays for them on the final legs.
 */
export const nearestNeighbour: RoutingStrategy = {
  id: 'nearest-neighbour',
  name: 'Nearest Neighbour',
  blurb: 'Greedy: always hop to the closest remaining pick. Fast, but strands outliers.',
  sequence(ctx, stops, start) {
    return greedyOrder(ctx, stops, start)
  },
}

/** Shared by the TSP strategy as its construction heuristic. */
export function greedyOrder(ctx: RoutingContext, stops: RouteStop[], start: NodeId): RouteStop[] {
  const remaining = stops.slice()
  const out: RouteStop[] = []
  let current = start

  while (remaining.length > 0) {
    let bestIndex = 0
    let bestCost = Infinity
    for (let i = 0; i < remaining.length; i++) {
      const cost = ctx.distance(current, remaining[i].node)
      if (cost < bestCost) {
        bestCost = cost
        bestIndex = i
      }
    }
    const [next] = remaining.splice(bestIndex, 1)
    out.push(next)
    current = next.node
  }
  return out
}
