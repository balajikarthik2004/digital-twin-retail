/**
 * Pathfinding types — pure TypeScript, zero rendering / framework dependencies.
 *
 * Floor coordinates use a 2D `Vec2` where `x` runs across aisles and `y` runs
 * along aisles (depth). The renderer maps `y -> Three.js z`; nothing in this
 * folder knows Three.js exists, so the same code can run in Node or a backend.
 */

export interface Vec2 {
  x: number
  y: number
}

export type NodeId = string

export interface NavNode {
  id: NodeId
  pos: Vec2
  /** Coarse classification, used by strategies that reason about topology. */
  kind: 'aisle' | 'cross' | 'dock' | 'pack' | 'staging'
  /** Aisle index for `aisle` nodes and cross-aisle nodes that sit on an aisle. */
  aisle?: number
  /** Cross-aisle index for `cross` nodes. */
  cross?: number
  /** Position along the aisle (depth rank), used for serpentine ordering. */
  rank?: number
}

export interface NavEdge {
  to: NodeId
  cost: number
}

/** Immutable, weighted, undirected navigation graph. */
export interface NavGraph {
  nodes: Map<NodeId, NavNode>
  adjacency: Map<NodeId, NavEdge[]>
}

/** A single stop on a route: somewhere the picker must physically stand. */
export interface RouteStop {
  /** Graph node the picker walks to. */
  node: NodeId
  /** Opaque payload (bin id, order line id, ...) carried through untouched. */
  ref: string
  /** Seconds of dwell time at this stop (pick time). */
  serviceTime: number
  /**
   * Caller-owned payload, passed through untouched. The simulation uses it to
   * carry which order line a stop belongs to; strategies must ignore it.
   */
  data?: unknown
}

/**
 * Everything a routing strategy is allowed to know. Strategies receive this
 * instead of the raw graph so distance queries can be memoised/precomputed.
 */
export interface RoutingContext {
  graph: NavGraph
  /** Shortest walking distance between two nodes (metres). Infinity if unreachable. */
  distance(a: NodeId, b: NodeId): number
  /** Node-by-node shortest path, inclusive of both endpoints. */
  path(a: NodeId, b: NodeId): NodeId[]
  node(id: NodeId): NavNode
}

/**
 * A routing strategy only decides the ORDER in which stops are visited.
 * Turning that order into a walkable polyline is done once, generically, by
 * `buildRoute()`. Adding a strategy therefore means implementing this one
 * interface and registering it — no rendering or simulation code changes.
 */
export interface RoutingStrategy {
  id: string
  name: string
  /** Shown in the UI next to the selector. */
  blurb: string
  /**
   * @param stops   Unordered stops to visit.
   * @param start   Node the picker starts from.
   * @param end     Node the picker must finish at (usually the same depot).
   * @returns       `stops` re-ordered. Must contain exactly the same members.
   */
  sequence(ctx: RoutingContext, stops: RouteStop[], start: NodeId, end: NodeId): RouteStop[]
}

/** A stop projected onto the final walkable polyline. */
export interface RouteWaypoint {
  stop: RouteStop
  /** Index into `Route.polyline`. */
  pointIndex: number
  /** Arc-length distance from the route start (metres). */
  arcLength: number
  /** 1-based visiting sequence number, for the numbered markers in 3D. */
  sequence: number
}

export interface Route {
  strategyId: string
  /** Ordered node ids actually walked, start -> ... -> end. */
  nodePath: NodeId[]
  /** Ordered floor positions matching `nodePath`. */
  polyline: Vec2[]
  /** Cumulative arc length at each polyline point; `cumulative[0] === 0`. */
  cumulative: number[]
  /** Stops in visiting order, projected onto the polyline. */
  waypoints: RouteWaypoint[]
  /** Total walking distance in metres. */
  distance: number
  /** Total dwell (pick) time in seconds. */
  serviceTime: number
}
