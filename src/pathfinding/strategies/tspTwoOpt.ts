import { tourLength } from '../route'
import type { NodeId, RouteStop, RoutingContext, RoutingStrategy } from '../types'
import { greedyOrder } from './nearestNeighbour'

/** Hard cap so a pathological pick list can never stall the animation loop. */
const MAX_PASSES = 40

/**
 * 2-opt improvement over a nearest-neighbour tour.
 *
 * 2-opt repeatedly reverses a contiguous run of the tour and keeps the reversal
 * whenever it shortens the total walk. Applied to an open tour (fixed start,
 * fixed end) this removes the crossings that greedy construction leaves behind
 * and lands within a few percent of optimal for pick-list sizes (5-40 stops)
 * without the cost of an exact solver.
 */
export const tspTwoOpt: RoutingStrategy = {
  id: 'tsp-2opt',
  name: 'TSP Heuristic (NN + 2-opt)',
  blurb: 'Near-optimal: greedy tour refined by 2-opt reversals until no swap helps.',
  sequence(ctx, stops, start, end) {
    return twoOptImprove(ctx, greedyOrder(ctx, stops, start), start, end)
  },
}

export function twoOptImprove(
  ctx: RoutingContext,
  initial: RouteStop[],
  start: NodeId,
  end: NodeId,
): RouteStop[] {
  const n = initial.length
  if (n < 3) return initial

  const tour = initial.slice()
  // Node ids at each tour position, padded with the fixed endpoints, so edge
  // costs are a single lookup: leg(i) is the edge entering tour position i.
  const nodeAt = (i: number): NodeId => (i < 0 ? start : i >= n ? end : tour[i].node)
  const leg = (i: number) => ctx.distance(nodeAt(i - 1), nodeAt(i))

  let improved = true
  let passes = 0

  while (improved && passes < MAX_PASSES) {
    improved = false
    passes++
    for (let i = 0; i < n - 1; i++) {
      for (let k = i + 1; k < n; k++) {
        // Reversing tour[i..k] only changes the two boundary edges.
        const before = leg(i) + ctx.distance(nodeAt(k), nodeAt(k + 1))
        const after =
          ctx.distance(nodeAt(i - 1), nodeAt(k)) + ctx.distance(nodeAt(i), nodeAt(k + 1))
        if (after < before - 1e-9) {
          reverse(tour, i, k)
          improved = true
        }
      }
    }
  }

  // Guard against a degenerate oracle making things worse; never regress.
  return tourLength(ctx, tour, start, end) <= tourLength(ctx, initial, start, end) ? tour : initial
}

function reverse<T>(arr: T[], i: number, k: number) {
  while (i < k) {
    ;[arr[i], arr[k]] = [arr[k], arr[i]]
    i++
    k--
  }
}
