import type { NavEdge, NavGraph, NavNode, NodeId, Vec2 } from './types'

export function dist2(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}

/** Mutable builder that produces an immutable-ish {@link NavGraph}. */
export class NavGraphBuilder {
  private nodes = new Map<NodeId, NavNode>()
  private adjacency = new Map<NodeId, NavEdge[]>()

  addNode(node: NavNode): NodeId {
    this.nodes.set(node.id, node)
    if (!this.adjacency.has(node.id)) this.adjacency.set(node.id, [])
    return node.id
  }

  has(id: NodeId): boolean {
    return this.nodes.has(id)
  }

  /** Undirected edge. Cost defaults to euclidean distance between the nodes. */
  link(a: NodeId, b: NodeId, cost?: number): void {
    const na = this.nodes.get(a)
    const nb = this.nodes.get(b)
    if (!na || !nb) throw new Error(`link(): unknown node ${!na ? a : b}`)
    if (a === b) return
    const w = cost ?? dist2(na.pos, nb.pos)
    this.pushEdge(a, { to: b, cost: w })
    this.pushEdge(b, { to: a, cost: w })
  }

  private pushEdge(from: NodeId, edge: NavEdge) {
    const list = this.adjacency.get(from)!
    const existing = list.find((e) => e.to === edge.to)
    if (existing) existing.cost = Math.min(existing.cost, edge.cost)
    else list.push(edge)
  }

  build(): NavGraph {
    return { nodes: this.nodes, adjacency: this.adjacency }
  }
}

/** Minimal binary min-heap; keeps Dijkstra O(E log V) without a dependency. */
class MinHeap<T> {
  private items: { key: number; value: T }[] = []

  get size() {
    return this.items.length
  }

  push(key: number, value: T) {
    const items = this.items
    items.push({ key, value })
    let i = items.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (items[parent].key <= items[i].key) break
      ;[items[parent], items[i]] = [items[i], items[parent]]
      i = parent
    }
  }

  pop(): T | undefined {
    const items = this.items
    if (items.length === 0) return undefined
    const top = items[0]
    const last = items.pop()!
    if (items.length > 0) {
      items[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let smallest = i
        if (l < items.length && items[l].key < items[smallest].key) smallest = l
        if (r < items.length && items[r].key < items[smallest].key) smallest = r
        if (smallest === i) break
        ;[items[smallest], items[i]] = [items[i], items[smallest]]
        i = smallest
      }
    }
    return top.value
  }
}

export interface DijkstraResult {
  dist: Map<NodeId, number>
  prev: Map<NodeId, NodeId>
}

/** Single-source Dijkstra over the whole graph. */
export function dijkstra(graph: NavGraph, source: NodeId): DijkstraResult {
  const dist = new Map<NodeId, number>()
  const prev = new Map<NodeId, NodeId>()
  const settled = new Set<NodeId>()
  const heap = new MinHeap<NodeId>()

  dist.set(source, 0)
  heap.push(0, source)

  while (heap.size > 0) {
    const u = heap.pop()!
    if (settled.has(u)) continue
    settled.add(u)
    const du = dist.get(u)!
    for (const edge of graph.adjacency.get(u) ?? []) {
      if (settled.has(edge.to)) continue
      const alt = du + edge.cost
      if (alt < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, alt)
        prev.set(edge.to, u)
        heap.push(alt, edge.to)
      }
    }
  }
  return { dist, prev }
}

/**
 * Distance/path oracle with lazy per-source Dijkstra memoisation.
 *
 * A pick list touches a few dozen nodes out of a few hundred, so running one
 * Dijkstra per distinct source and caching it is both simpler and faster than
 * a full all-pairs matrix — and it stays cheap as the warehouse grows.
 */
export class ShortestPathOracle {
  private cache = new Map<NodeId, DijkstraResult>()

  constructor(readonly graph: NavGraph) {}

  private from(source: NodeId): DijkstraResult {
    let r = this.cache.get(source)
    if (!r) {
      r = dijkstra(this.graph, source)
      this.cache.set(source, r)
    }
    return r
  }

  distance(a: NodeId, b: NodeId): number {
    if (a === b) return 0
    return this.from(a).dist.get(b) ?? Infinity
  }

  /** Inclusive node path `[a, ..., b]`; `[]` when unreachable. */
  path(a: NodeId, b: NodeId): NodeId[] {
    if (a === b) return [a]
    const { dist, prev } = this.from(a)
    if (!dist.has(b)) return []
    const out: NodeId[] = []
    let cur: NodeId | undefined = b
    while (cur !== undefined) {
      out.push(cur)
      if (cur === a) break
      cur = prev.get(cur)
    }
    return out.reverse()
  }

  clear(): void {
    this.cache.clear()
  }
}
