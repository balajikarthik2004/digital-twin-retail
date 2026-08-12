import type { Route, Vec2 } from '../pathfinding/types'
import type { Vec3 } from '../warehouse/conveyor'
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
  /** Totes picked, but the pack induction buffer is full — the picker waits. */
  | 'awaitPack'
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
  kind: 'dispatch' | 'batch' | 'plan' | 'reroute' | 'wait' | 'short' | 'break' | 'done' | 'pack'
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
  /** Service time this stop started with, so lift progress can be a fraction of it. */
  dwellTotal: number
  /**
   * Height of the picker's platform above the floor, metres.
   *
   * Non-zero only while servicing a reserve location: the picker rises to the
   * bulk level, works, and comes back down inside the (already much longer)
   * dwell for that stop. Driven by the engine rather than tweened in the scene
   * so it steps with the simulation clock — at 20× the lift is 20× faster,
   * exactly like every other motion on the floor.
   */
  lift: number
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
  /** Picked orders not yet accepted by pack — non-empty means the buffer is full. */
  pendingJobs: PackJob[]
  /** Seconds lost waiting for a free slot in the pack induction buffer. */
  packWaitTime: number
}

/**
 * One picked order handed from a picker to the pack line.
 *
 * Carries the picking outcome forward so the completion record can report the
 * whole lifecycle — walked distance, pack time and conveyor transit — rather
 * than only the part that happened in the aisles.
 */
export interface PackJob {
  orderId: string
  ref: string
  channel: Order['channel']
  priority: Order['priority']
  lines: number
  units: number
  agentId: string
  agentLabel: string
  strategyId: string
  tourId: number
  batchSize: number
  /** Walked / planned distance apportioned to this order's share of the tour. */
  distance: number
  planned: number
  /** Sim time the picker was assigned the order, and when pack took the totes. */
  assignedAt: number
  pickedAt: number
  dueAt: number
}

export type PackStationPhase = 'idle' | 'packing' | 'mergeBlocked' | 'unstaffed'

/** Live state of one pack bench. */
export interface PackStation {
  id: string
  index: number
  label: string
  pos: Vec2
  staffed: boolean
  phase: PackStationPhase
  job: PackJob | null
  /** Seconds left on the current pack cycle, and its total, for a progress bar. */
  remaining: number
  cycleLength: number
  /** Per-bench pace multiplier — benches are not identical. */
  efficiency: number
  /** A finished parcel waiting for a gap in the takeaway conveyor. */
  holding: Parcel | null
  ordersPacked: number
  cartonsPacked: number
  busyTime: number
  idleTime: number
  blockedTime: number
  totalPackTime: number
}

export type ParcelStage = 'conveying' | 'staged' | 'dispatched'

/** A packed parcel on its way from a bench to a dock. */
export interface Parcel {
  id: string
  seq: number
  orderId: string
  ref: string
  channel: Order['channel']
  priority: Order['priority']
  cartons: number
  weightKg: number
  stationIndex: number
  stationLabel: string
  dockIndex: number
  dockLabel: string
  stage: ParcelStage
  /** Distance travelled along the bench → dock belt path. */
  arc: number
  pathLength: number
  pos: Vec3
  heading: number
  /** True while held at a merge point or behind a full sorter. */
  blocked: boolean
  /** Hand-carried because conveyor sortation is switched off. */
  manual: boolean
  packedAt: number
  stagedAt: number
  /** Slot in the dock's outbound stack, once staged. */
  stackIndex: number
}

/** Pack bench row in the dashboard. */
export interface PackStationMetrics {
  id: string
  label: string
  phase: PackStationPhase
  staffed: boolean
  ref: string | null
  channel: string | null
  /** 0..1 through the current pack cycle. */
  progress: number
  ordersPacked: number
  cartonsPacked: number
  avgPackSec: number
  utilisation: number
  blockedShare: number
}

/** Dock row in the dashboard. */
export interface DockMetrics {
  id: string
  label: string
  /** Sales channels the sorter routes to this door. */
  channels: Order['channel'][]
  inbound: number
  staged: number
  dispatched: number
  trailers: number
  cartons: number
  /** Cartons in the stack waiting on the pad right now. */
  stagedCartons: number
  /**
   * Sim seconds the oldest currently-staged parcel landed, or 0 with an empty
   * pad. This is what the door's dwell clock counts from — a part-full trailer
   * seals on time, not on volume, so without it the door's progress cannot be
   * shown honestly.
   */
  oldestStagedAt: number
}

export interface CompletedOrder {
  orderId: string
  ref: string
  agentId: string
  strategyId: string
  /** Identifies the tour this order was picked in; shared across a batch. */
  tourId: number
  /** Actual walked distance apportioned across the tour's orders. */
  distance: number
  /** Planned distance for the same share, for planned-vs-actual. */
  planned: number
  /** Simulation seconds from picker assignment to staged at the dock. */
  duration: number
  /** Lifecycle split: aisles, then bench, then belt. */
  pickSeconds: number
  packSeconds: number
  conveySeconds: number
  picks: number
  shorts: number
  cartons: number
  /** Where it was packed, and which door it sorted to. */
  packStation: string
  dock: string
  finishedAt: number
  dueAt: number
  onTime: boolean
  /** Orders picked together in the same tour. */
  batchSize: number
}

export interface SimEvent {
  id: number
  at: number
  kind:
    | 'assigned'
    | 'completed'
    | 'congestion'
    | 'released'
    | 'info'
    | 'short'
    | 'late'
    | 'break'
    /** Handed to pack, packed into parcels, or a trailer sealed at a dock. */
    | 'handoff'
    | 'pack'
    | 'dispatch'
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
  /** Seconds spent dropping totes at the pack station, before the embodiment's factor. */
  unloadTimeSec: number
  /** Agents closer than this (metres) trigger a yield + congestion event. */
  congestionRadius: number

  // ── pack-out & dispatch ───────────────────────────────────────────────────
  /** Benches manned this shift, capped by the layout's pack station count. */
  packStaff: number
  /** Fixed seconds per parcel: carton make-up, docs, label, tape. */
  packSetupSec: number
  /** Seconds to check and wrap each order line. */
  packPerLineSec: number
  /** Additional seconds per unit packed. */
  packPerUnitSec: number
  /** Units that fit one carton — drives how many parcels an order becomes. */
  unitsPerCarton: number
  /** Belt speed of the takeaway conveyor and outbound sorter, m/s. */
  conveyorSpeed: number
  /** Off = parcels are hand-trucked to the dock instead of conveyed. */
  conveyorSortation: boolean
  /** Totes that fit in the pack induction buffer before pickers must hold. */
  packBufferLimit: number

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

/**
 * One line on a picker's task list — the WMS view of the tour being walked.
 *
 * This is the same data the 3D view draws as numbered markers on the floor, in
 * the form an operator would actually be handed it: location code, SKU, quantity
 * and which order it belongs to, in visiting order. `sequence` matches the
 * markers exactly, so a stop read off the panel can be found in the aisle.
 */
export interface PickTask {
  /** 1-based visiting sequence, matching the numbered markers in the scene. */
  sequence: number
  binId: string
  /** Operator-facing location code, e.g. `A03-R14-2B`. */
  code: string
  aisle: number
  sku: string
  skuName: string
  qty: number
  /** Customer-facing reference of the order this line belongs to. */
  orderRef: string
  status: 'done' | 'current' | 'pending'
  /** Metres from the start of the tour to this stop. */
  arcLength: number
  /**
   * Retrieved from the bulk tier above the pick face rather than reached on
   * foot. The walk is identical — routing is bay-level — but the retrieval is
   * several times longer, so it is worth calling out on the task card.
   */
  reserve: boolean
  /** 1-based level within whichever tier this location is on. */
  levelInTier: number
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
  /** The current tour in visiting order; empty when the picker has no route. */
  tasks: PickTask[]
  /** Metres planned for the current tour, for planned-vs-actual on the tour. */
  routeDistance: number
  /** Metres walked on the current tour so far. */
  tourDistance: number
  /**
   * Where the shift has actually gone, in seconds. Walking, picking and waiting
   * are the three numbers that decide whether a layout or a staffing level is
   * the problem, so they are published rather than rolled into utilisation.
   */
  walkTime: number
  pickTime: number
  waitTime: number
  idleTime: number
  breakTime: number
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
  /** Orders staged at a dock — the full pick → pack → dispatch lifecycle done. */
  ordersCompleted: number
  ordersPending: number
  ordersInProgress: number
  ordersTotal: number

  // ── pack-out & dispatch pipeline ──────────────────────────────────────────
  /** Cumulative orders picked and handed over to the pack line. */
  ordersPicked: number
  /** Depth of the shared pack induction buffer. */
  ordersAwaitingPack: number
  /** Orders on a bench right now. */
  ordersPacking: number
  parcelsInTransit: number
  parcelsStaged: number
  parcelsPacked: number
  parcelsDispatched: number
  cartonsPacked: number
  trailersSealed: number
  avgPackSec: number
  avgConveySec: number
  /** Share of manned bench time spent packing rather than starved or blocked. */
  packUtilisation: number
  /** Deepest the induction buffer got — the picker-side symptom of a pack bottleneck. */
  packBufferPeak: number
  /** Parcels held at a spur because the takeaway conveyor had no gap. */
  mergeBlocks: number
  /** Seconds pickers spent unable to hand over because the buffer was full. */
  packWaitSeconds: number
  packStations: PackStationMetrics[]
  docks: DockMetrics[]
  /** Parcels currently in the facility, newest first — drives the 3D and the list. */
  parcels: Parcel[]
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
