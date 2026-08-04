import type { Route, Vec2 } from '../pathfinding/types'
import type { PickerKind } from './pickerProfiles'

export interface OrderLine {
  /** SKU identifier (informational — routing uses `binId`). */
  sku: string
  /** Storage location this line is picked from. */
  binId: string
  qty: number
}

export interface Order {
  id: string
  /** Customer-facing reference shown in the UI. */
  ref: string
  channel: 'Ecommerce' | 'Store Replen' | 'Click & Collect' | 'Wholesale'
  priority: 'express' | 'standard'
  /** Simulation time (seconds) at which the order becomes pickable. */
  releasedAt: number
  /** Simulation time by which the order should be packed (SLA). */
  dueAt: number
  lines: OrderLine[]
}

export type AgentPhase =
  | 'idle'
  | 'traveling'
  | 'picking'
  | 'returning'
  | 'unloading'
  | 'blocked'
  | 'break'

/**
 * One decision the picker made, in plain language.
 *
 * This is the "thinking" surface: dispatch choices, batching, re-routes, short
 * picks and breaks all leave a trace, so a stakeholder can see *why* an agent
 * did something rather than just watching it move.
 */
export interface Thought {
  id: number
  at: number
  kind: 'dispatch' | 'batch' | 'plan' | 'reroute' | 'wait' | 'short' | 'break' | 'done'
  text: string
}

export interface PickerAgent {
  id: string
  label: string
  /** Hex colour, shared by the 3D agent, its trail and its dashboard row. */
  color: string
  kind: PickerKind
  /** Node the picker starts from and returns to. */
  homeNode: string
  phase: AgentPhase
  pos: Vec2
  /** Facing angle in radians (atan2 of travel direction), for the 3D mesh. */
  heading: number
  /** Orders in the current tour. More than one means batch picking. */
  orders: Order[]
  route: Route | null
  /** Distance travelled along the current route (metres). */
  arc: number
  /** Index of the next un-serviced waypoint on the route. */
  nextWaypoint: number
  dwellRemaining: number
  currentBinId: string | null
  /** Most recent decisions, newest last. */
  thoughts: Thought[]
  /** Lines loaded in this tour vs the embodiment's capacity. */
  linesLoaded: number
  capacityLines: number
  /** Cumulative metrics. */
  distanceTraveled: number
  /** Distance at the moment the current tour started, for planned-vs-actual. */
  tourStartDistance: number
  plannedDistance: number
  walkTime: number
  pickTime: number
  waitTime: number
  idleTime: number
  breakTime: number
  picksDone: number
  ordersDone: number
  shortPicks: number
  reroutes: number
  batchedTours: number
  congestionEvents: number
  orderStartedAt: number
  totalOrderTime: number
  /** Seconds of productive work since the last break. */
  sinceBreak: number
  /** Sim time this agent's break ends. */
  breakUntil: number
  /** How long the agent has been unable to move, in seconds. */
  blockedFor: number
}

export interface CompletedOrder {
  orderId: string
  ref: string
  agentId: string
  strategyId: string
  /** Identifies the tour this order was packed in; shared across a batch. */
  tourId: number
  /** Actual walked distance apportioned across the tour's orders. */
  distance: number
  /** Planned distance for the same share, for planned-vs-actual. */
  planned: number
  /** Wall-clock simulation seconds from assignment to drop-off. */
  duration: number
  picks: number
  shorts: number
  finishedAt: number
  dueAt: number
  onTime: boolean
  /** Orders packed together in the same tour. */
  batchSize: number
}

export interface SimEvent {
  id: number
  at: number
  kind: 'assigned' | 'completed' | 'congestion' | 'released' | 'info' | 'short' | 'late' | 'break'
  message: string
}

export interface SimSettings {
  agentCount: number
  strategyId: string
  pickerKind: PickerKind
  /** Base walking speed before the embodiment's factor, m/s. */
  pickerSpeed: number
  /** Fixed seconds per pick line, before the embodiment's factor. */
  pickTimeSec: number
  /** Additional seconds per unit. */
  perUnitTimeSec: number
  /** Seconds spent at the pack station per tour, before the embodiment's factor. */
  unloadTimeSec: number
  /** Agents closer than this (metres) trigger a yield + congestion event. */
  congestionRadius: number

  // ── behaviour switches (each is visible in the metrics when toggled) ──────
  /** Choose the next order by urgency + proximity instead of plain FIFO. */
  smartDispatch: boolean
  /** Combine nearby orders into one tour up to the embodiment's capacity. */
  batchOrders: boolean
  /** Re-plan around a blocked aisle instead of waiting it out. */
  rerouting: boolean
  /** Scheduled rest breaks and mild fatigue over the shift. */
  restBreaks: boolean
  /** Decrement on-hand stock, produce short picks and replen flags. */
  stockDepletion: boolean
}

export interface AgentMetrics {
  id: string
  label: string
  color: string
  kind: PickerKind
  phase: AgentPhase
  distance: number
  picks: number
  orders: number
  avgOrderTime: number
  utilisation: number
  congestionEvents: number
  shortPicks: number
  reroutes: number
  /** Order refs in the current tour. */
  orderRefs: string[]
  /** 0..1 progress along the current route. */
  progress: number
  routeStops: number
  stopsDone: number
  linesLoaded: number
  capacityLines: number
  thoughts: Thought[]
}

export interface SimMetrics {
  time: number
  running: boolean
  /** All distance walked, including tours still in flight. */
  totalDistance: number
  /** Distance walked on COMPLETED tours only — the like-for-like partner to `totalPlanned`. */
  totalActual: number
  /** Planned distance for those same completed tours. */
  totalPlanned: number
  totalPicks: number
  ordersCompleted: number
  ordersPending: number
  ordersInProgress: number
  ordersTotal: number
  avgOrderTime: number
  avgDistancePerOrder: number
  congestionEvents: number
  utilisation: number
  /** Completed orders extrapolated to orders/hour. */
  throughput: number
  linesPerHour: number
  /** Share of completed orders packed before their SLA. */
  onTimeRate: number
  ordersLate: number
  shortPicks: number
  reroutes: number
  batchedTours: number
  avgBatchSize: number
  /** Storage locations currently at or below their replen point. */
  replenAlerts: number
  agents: AgentMetrics[]
  /** Rolling series for the throughput chart. */
  series: { t: number; completed: number; distance: number }[]
  recent: CompletedOrder[]
  events: SimEvent[]
}

/** One row of the strategy comparison table/chart. */
export interface StrategyComparison {
  strategyId: string
  name: string
  blurb: string
  totalDistance: number
  avgDistancePerOrder: number
  totalPickTimeSec: number
  totalWalkTimeSec: number
  estTotalTimeSec: number
  estOrdersPerPickerHour: number
  orders: number
  lines: number
}
