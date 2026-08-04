import type { RoutingStrategy } from '../types'

/**
 * S-shape / serpentine traversal — the industry baseline.
 *
 * The picker enters the lowest-numbered aisle containing a pick, walks it end
 * to end, crosses over, walks the next aisle in the opposite direction, and so
 * on. Aisles with no picks are skipped entirely. Simple to train, easy to
 * follow, and reliably 15-35% longer than a good tour — which is exactly the
 * gap the comparison mode is there to show.
 */
export const serpentine: RoutingStrategy = {
  id: 'serpentine',
  name: 'S-Shape (serpentine)',
  blurb: 'Baseline: sweep aisles in order, alternating direction. Easy to train, longest walk.',
  sequence(ctx, stops, start) {
    const startPos = ctx.node(start).pos

    // Bucket stops by aisle; stops without an aisle (dock/pack) trail behind.
    const byAisle = new Map<number, typeof stops>()
    const unassigned: typeof stops = []
    for (const stop of stops) {
      const node = ctx.node(stop.node)
      if (node.aisle === undefined) {
        unassigned.push(stop)
        continue
      }
      const list = byAisle.get(node.aisle)
      if (list) list.push(stop)
      else byAisle.set(node.aisle, [stop])
    }

    const aisles = [...byAisle.keys()].sort((a, b) => a - b)

    // Enter from whichever end of the first aisle is closer to the depot.
    const firstAisleStops = aisles.length ? byAisle.get(aisles[0])! : []
    const depthOf = (s: (typeof stops)[number]) => ctx.node(s.node).pos.y
    let forward = true
    if (firstAisleStops.length > 0) {
      const depths = firstAisleStops.map(depthOf)
      const near = Math.min(...depths)
      const far = Math.max(...depths)
      forward = Math.abs(near - startPos.y) <= Math.abs(far - startPos.y)
    }

    const out: typeof stops = []
    for (const aisle of aisles) {
      const list = byAisle.get(aisle)!
      list.sort((a, b) => (forward ? depthOf(a) - depthOf(b) : depthOf(b) - depthOf(a)))
      out.push(...list)
      forward = !forward
    }
    out.push(...unassigned)
    return out
  },
}
