import type { RoutingStrategy } from '../types'
import { nearestNeighbour } from './nearestNeighbour'
import { serpentine } from './serpentine'
import { tspTwoOpt } from './tspTwoOpt'

/**
 * Strategy registry.
 *
 * ── To add a routing strategy ───────────────────────────────────────────────
 *   1. Create `./myStrategy.ts` exporting a `RoutingStrategy`.
 *   2. Add it to the array below.
 * That's it — the selector, the comparison chart, the 3D path rendering and the
 * simulation all read from this registry, so nothing else needs editing.
 */
export const ROUTING_STRATEGIES: RoutingStrategy[] = [serpentine, nearestNeighbour, tspTwoOpt]

export const DEFAULT_STRATEGY_ID = tspTwoOpt.id

const byId = new Map(ROUTING_STRATEGIES.map((s) => [s.id, s]))

export function getStrategy(id: string): RoutingStrategy {
  const s = byId.get(id)
  if (!s) throw new Error(`Unknown routing strategy: ${id}`)
  return s
}

export { serpentine, nearestNeighbour, tspTwoOpt }
