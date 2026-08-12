import { ShortestPathOracle } from '../pathfinding/graph'
import { buildRoute, createRoutingContext } from '../pathfinding/route'
import { getStrategy } from '../pathfinding/strategies'
import type { NodeId, Route, RouteStop, RoutingContext, Vec2 } from '../pathfinding/types'
import { isReserveLevel, levelDeckTop, reserveTierIndex } from '../warehouse/rackGeometry'
import type { Bin, WarehouseModel } from '../warehouse/types'
import { PackLine } from './packLine'
import { profileFor } from './pickerProfiles'
import type {
  AgentMetrics,
  CompletedOrder,
  Order,
  PackJob,
  PackStation,
  Parcel,
  PickerAgent,
  PickTask,
  SimEvent,
  SimMetrics,
  SimSettings,
  Thought,
} from './types'

/**
 * Fallback identity colours. The app overrides these per theme via
 * `setAgentPalette()` — see `AGENT_PALETTES` in `src/ui/theme.ts`, which holds
 * the validated categorical order for each mode.
 */
export const AGENT_COLORS = [
  '#4a3aa7',
  '#e87ba4',
  '#eda100',
  '#008300',
  '#2a78d6',
  '#e34948',
  '#1baf7a',
  '#eb6834',
]

/**
 * Fleet ceiling. Deliberately decoupled from the palette length: there are only
 * eight validated identity colours, so past the eighth picker the palette cycles
 * and the numeric label (P9, P10, …) carries identity — every picker wears it as
 * a 3D sprite and as text on its dashboard chip, so identity never rests on
 * colour alone. 24 is enough to saturate even the 12-aisle regional layout,
 * which is the point: crowding a module is a result worth being able to show.
 */
export const MAX_AGENTS = 24

const EPS = 1e-6
/** Simulation is integrated in fixed slices so 20x speed stays stable. */
const MAX_SUBSTEP = 0.1
const MAX_SUBSTEPS_PER_FRAME = 60
/** Seconds before the same pair of agents can log another congestion event. */
const CONGESTION_COOLDOWN = 5
const SERIES_INTERVAL = 15
const MAX_SERIES_POINTS = 80
const MAX_THOUGHTS = 10

/** Seconds blocked before the picker gives up waiting and re-plans. */
const BLOCK_PATIENCE = 4
/** A candidate order joins a batch only if its nearest stop is this close to the tour. */
const BATCH_RADIUS_M = 26
const MAX_BATCH_ORDERS = 4
/** Productive seconds between rest breaks, and how long a break lasts. */
const WORK_BEFORE_BREAK = 55 * 60
const BREAK_DURATION = 5 * 60
/** How much speed decays across a full stint before a break. */
const MAX_FATIGUE_LOSS = 0.12

/**
 * Dwell multiplier for retrieving from the reserve tier rather than the pick
 * face, and the extra cost of each level further up it. Bulk retrieval is the
 * single most expensive thing a picker can be asked to do on a tour, which is
 * what makes "why is this order slow?" have a visible, physical answer.
 */
const RESERVE_PICK_FACTOR = 2.6
const RESERVE_LEVEL_PENALTY = 0.45

export interface SampledPose {
  pos: Vec2
  heading: number
}

/** Position + facing at a given arc length along a route. */
export function sampleRoute(route: Route, arc: number): SampledPose {
  const { polyline, cumulative } = route
  if (polyline.length === 0) return { pos: { x: 0, y: 0 }, heading: 0 }
  if (polyline.length === 1) return { pos: polyline[0], heading: 0 }

  const total = cumulative[cumulative.length - 1]
  const target = Math.max(0, Math.min(arc, total))

  let lo = 0
  let hi = cumulative.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (cumulative[mid] <= target) lo = mid
    else hi = mid
  }

  const a = polyline[lo]
  const b = polyline[hi]
  const segLen = cumulative[hi] - cumulative[lo]
  const t = segLen > EPS ? (target - cumulative[lo]) / segLen : 0
  return {
    pos: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
    heading: Math.atan2(b.x - a.x, b.y - a.y),
  }
}

/** Which order line a route stop came from. */
interface StopData {
  orderId: string
  lineIndex: number
  qty: number
}

/**
 * Discrete-time warehouse picking simulation.
 *
 * Beyond moving agents along routes, this models the decisions a real picker
 * makes: which order to take next, whether to batch a second order into the
 * same tour, whether to wait out a blocked aisle or re-plan around it, what to
 * do when a location is short, and when to take a break. Every one of those
 * decisions is recorded as a `Thought` so the reasoning is inspectable.
 *
 * Deliberately framework-free: the engine owns agent state and is stepped by
 * whoever drives the clock. The 3D scene reads `engine.agents` directly every
 * frame; React only consumes throttled `metrics()` snapshots.
 */
export class SimulationEngine {
  time = 0
  running = false
  agents: PickerAgent[] = []

  private model: WarehouseModel
  private ctx: RoutingContext
  private settings: SimSettings
  private orders: Order[] = []
  private ordersById = new Map<string, Order>()
  private releaseCursor = 0
  private queue: Order[] = []
  private assignedIds = new Set<string>()
  private completed: CompletedOrder[] = []
  private events: SimEvent[] = []
  private eventSeq = 1
  private thoughtSeq = 1
  private tourSeq = 1
  private congestionPairs = new Map<string, number>()
  private congestionTotal = 0
  private replenAlerts = new Set<string>()
  private series: { t: number; completed: number; distance: number }[] = [
    { t: 0, completed: 0, distance: 0 },
  ]
  private nextSeriesAt = SERIES_INTERVAL
  /** Cached per-order nearest-stop node lookups, for dispatch scoring. */
  private orderNodes = new Map<string, NodeId[]>()
  private palette: string[] = AGENT_COLORS
  /** Pack-out, conveyor sortation and trailer loading. */
  private packLine: PackLine

  constructor(model: WarehouseModel, settings: SimSettings) {
    this.model = model
    this.settings = settings
    this.ctx = createRoutingContext(model.graph, new ShortestPathOracle(model.graph))
    this.packLine = new PackLine(model, settings, {
      log: (kind, message) => this.log(kind, message),
      complete: (record) => this.recordCompletion(record),
    })
    this.spawnAgents(settings.agentCount)
  }

  // ── configuration ─────────────────────────────────────────────────────────

  get routingContext(): RoutingContext {
    return this.ctx
  }

  /** Live parcels, for the 3D scene. */
  get parcels(): Parcel[] {
    return this.packLine.parcels
  }

  /** Live pack benches, for the 3D scene. */
  get packStations(): PackStation[] {
    return this.packLine.stations
  }

  /**
   * Every order shipped this run, oldest first. `metrics().recent` is a short
   * tail for the dashboard; the history view needs the whole log.
   */
  get completedOrders(): CompletedOrder[] {
    return this.completed
  }

  getSettings(): SimSettings {
    return this.settings
  }

  updateSettings(patch: Partial<SimSettings>): void {
    const before = this.settings
    this.settings = { ...before, ...patch }
    if (patch.agentCount !== undefined && patch.agentCount !== before.agentCount) {
      this.resizeAgents(patch.agentCount)
    }
    if (patch.pickerKind !== undefined && patch.pickerKind !== before.pickerKind) {
      const profile = profileFor(patch.pickerKind)
      for (const agent of this.agents) {
        agent.kind = patch.pickerKind
        agent.capacityLines = profile.capacityLines
      }
      this.log(
        'info',
        `Fleet switched to ${profile.name} — ${profile.capacityLines} lines per tour, ${(profile.speedFactor * 100).toFixed(0)}% pace`,
      )
    }
    if (patch.strategyId !== undefined && patch.strategyId !== before.strategyId) {
      this.log('info', `Routing strategy switched to ${getStrategy(patch.strategyId).name}`)
    }

    this.packLine.configure(this.settings)
    if (patch.packStaff !== undefined && patch.packStaff !== before.packStaff) {
      this.log('info', `Pack wall staffed to ${this.packLine.staffedCount} bench(es)`)
    }
    if (
      patch.conveyorSortation !== undefined &&
      patch.conveyorSortation !== before.conveyorSortation
    ) {
      this.log(
        'info',
        patch.conveyorSortation
          ? 'Conveyor sortation online — parcels take the takeaway line to their door'
          : 'Conveyor sortation offline — parcels are hand-trucked to the docks',
      )
    }
  }

  /**
   * Replace the picker identity colours (used when the UI theme changes).
   * Assignment stays index-based so a picker keeps its identity across a swap.
   */
  setAgentPalette(colors: string[]): void {
    if (colors.length === 0) return
    this.palette = colors
    this.agents.forEach((agent, i) => {
      agent.color = colors[i % colors.length]
    })
  }

  setOrders(orders: Order[]): void {
    this.orders = orders.slice().sort((a, b) => a.releasedAt - b.releasedAt)
    this.ordersById = new Map(this.orders.map((o) => [o.id, o]))
    this.orderNodes.clear()
    this.reset({ keepOrders: true })
  }

  getOrders(): Order[] {
    return this.orders
  }

  /** Reset the clock, agents, stock and metrics. Order list preserved by default. */
  reset(opts: { keepOrders?: boolean } = {}): void {
    this.time = 0
    this.running = false
    this.releaseCursor = 0
    this.queue = []
    this.assignedIds.clear()
    this.completed = []
    this.events = []
    this.congestionPairs.clear()
    this.congestionTotal = 0
    this.replenAlerts.clear()
    this.series = [{ t: 0, completed: 0, distance: 0 }]
    this.nextSeriesAt = SERIES_INTERVAL
    this.packLine.reset()
    if (!opts.keepOrders) {
      this.orders = []
      this.ordersById.clear()
    }
    // Restore on-hand levels so repeated runs are comparable.
    for (const bin of this.model.bins) bin.sku.stock = bin.sku.stockInitial
    this.spawnAgents(this.settings.agentCount)
  }

  start(): void {
    if (this.orders.length === 0) return
    this.running = true
  }

  pause(): void {
    this.running = false
  }

  // ── agents ────────────────────────────────────────────────────────────────

  private homeNodeFor(index: number): string {
    const packs = this.model.facilities.filter((f) => f.kind === 'pack')
    return packs.length > 0 ? packs[index % packs.length].node : this.model.depot
  }

  private makeAgent(index: number): PickerAgent {
    const homeNode = this.homeNodeFor(index)
    const home = this.model.graph.nodes.get(homeNode)!
    const profile = profileFor(this.settings.pickerKind)
    return {
      id: `picker-${index + 1}`,
      label: `P${index + 1}`,
      color: this.palette[index % this.palette.length],
      kind: profile.kind,
      homeNode,
      phase: 'idle',
      pos: { ...home.pos },
      heading: 0,
      orders: [],
      route: null,
      arc: 0,
      nextWaypoint: 0,
      dwellRemaining: 0,
      dwellTotal: 0,
      lift: 0,
      currentBinId: null,
      thoughts: [],
      linesLoaded: 0,
      capacityLines: profile.capacityLines,
      distanceTraveled: 0,
      tourStartDistance: 0,
      plannedDistance: 0,
      walkTime: 0,
      pickTime: 0,
      waitTime: 0,
      idleTime: 0,
      breakTime: 0,
      picksDone: 0,
      ordersDone: 0,
      shortPicks: 0,
      reroutes: 0,
      batchedTours: 0,
      congestionEvents: 0,
      orderStartedAt: 0,
      totalOrderTime: 0,
      sinceBreak: 0,
      breakUntil: 0,
      blockedFor: 0,
      pendingJobs: [],
      packWaitTime: 0,
    }
  }

  private spawnAgents(count: number): void {
    this.agents = Array.from({ length: clampAgents(count) }, (_, i) => this.makeAgent(i))
  }

  private resizeAgents(count: number): void {
    const target = clampAgents(count)
    while (this.agents.length < target) this.agents.push(this.makeAgent(this.agents.length))
    while (this.agents.length > target) {
      const dropped = this.agents.pop()!
      // Return in-flight orders to the queue so nothing is silently lost.
      for (const order of dropped.orders) {
        this.assignedIds.delete(order.id)
        this.queue.unshift(order)
      }
      // Totes already picked go to pack regardless of the buffer limit — the
      // work is done, and dropping it would silently lose an order.
      for (const job of dropped.pendingJobs) {
        this.packLine.induct(job, true)
        this.assignedIds.delete(job.orderId)
      }
      dropped.pendingJobs = []
    }
  }

  private think(agent: PickerAgent, kind: Thought['kind'], text: string): void {
    agent.thoughts.push({ id: this.thoughtSeq++, at: this.time, kind, text })
    if (agent.thoughts.length > MAX_THOUGHTS) agent.thoughts.shift()
  }

  // ── main loop ─────────────────────────────────────────────────────────────

  advance(realDt: number, timeScale: number): void {
    if (!this.running) return
    let remaining = Math.max(0, Math.min(realDt, 0.25)) * timeScale
    let guard = 0
    while (remaining > EPS && guard++ < MAX_SUBSTEPS_PER_FRAME) {
      const dt = Math.min(MAX_SUBSTEP, remaining)
      this.step(dt)
      remaining -= dt
    }
  }

  /** One fixed simulation slice. Exposed for deterministic tests. */
  step(dt: number): void {
    this.time += dt
    this.releaseOrders()
    this.dispatch()
    const yields = this.resolveCongestion()
    for (const agent of this.agents) this.stepAgent(agent, dt, yields.get(agent.id) ?? 1)
    // Pack-out runs on the same slice as the floor, so a 20x clock cannot let
    // parcels tunnel through a merge point.
    this.packLine.step(dt, this.time)
    this.sampleSeries()

    if (this.isDrained()) {
      // Nothing else is coming, so part-full trailers ship rather than sitting
      // on the dock forever.
      this.packLine.stepTrailers(this.time, true)
      this.running = false
      this.log('info', 'Wave picked, packed and dispatched — simulation idle.')
    }
  }

  private isDrained(): boolean {
    return (
      this.releaseCursor >= this.orders.length &&
      this.queue.length === 0 &&
      this.agents.every((a) => a.phase === 'idle') &&
      !this.packLine.busy
    )
  }

  private releaseOrders(): void {
    while (
      this.releaseCursor < this.orders.length &&
      this.orders[this.releaseCursor].releasedAt <= this.time
    ) {
      const order = this.orders[this.releaseCursor++]
      this.queue.push(order)
      this.log('released', `${order.ref} released · ${order.lines.length} lines · ${order.channel}`)
    }
  }

  // ── decision: which order next, and can anything ride along? ──────────────

  private nodesFor(order: Order): NodeId[] {
    let nodes = this.orderNodes.get(order.id)
    if (!nodes) {
      const set = new Set<NodeId>()
      for (const line of order.lines) {
        const bin = this.model.binsById.get(line.binId)
        if (bin) set.add(bin.node)
      }
      nodes = [...set]
      this.orderNodes.set(order.id, nodes)
    }
    return nodes
  }

  /** Shortest distance from `from` to any stop of `order`. */
  private reachOf(from: NodeId, order: Order): number {
    let best = Infinity
    for (const node of this.nodesFor(order)) {
      const d = this.ctx.distance(from, node)
      if (d < best) best = d
    }
    return best
  }

  private dispatch(): void {
    for (const agent of this.agents) {
      if (agent.phase !== 'idle' || this.queue.length === 0) continue
      if (this.settings.restBreaks && this.time < agent.breakUntil) continue

      const seedIndex = this.chooseOrder(agent)
      if (seedIndex < 0) continue
      const [seed] = this.queue.splice(seedIndex, 1)

      const batch = [seed]
      if (this.settings.batchOrders) this.fillBatch(agent, batch)

      this.assign(agent, batch)
    }
  }

  /**
   * Pick the next order. FIFO is the honest baseline; smart dispatch trades a
   * little fairness for a lot of walking by weighing SLA urgency against how far
   * the order is from where the picker is standing right now.
   */
  private chooseOrder(agent: PickerAgent): number {
    if (this.queue.length === 0) return -1
    if (!this.settings.smartDispatch) {
      // Plain FIFO with express jumping the queue.
      let best = 0
      for (let i = 1; i < this.queue.length; i++) {
        const a = this.queue[i]
        const b = this.queue[best]
        const aExpress = a.priority === 'express'
        const bExpress = b.priority === 'express'
        if (aExpress !== bExpress ? aExpress : a.releasedAt < b.releasedAt) best = i
      }
      const chosen = this.queue[best]
      this.think(
        agent,
        'dispatch',
        `Took ${chosen.ref} — next in the queue (${chosen.priority}, ${chosen.lines.length} lines)`,
      )
      return best
    }

    const from = agent.homeNode
    let bestIndex = -1
    let bestScore = -Infinity
    let runnerUp: { ref: string; score: number; reach: number } | null = null
    let bestReach = 0

    for (let i = 0; i < this.queue.length; i++) {
      const order = this.queue[i]
      const reach = this.reachOf(from, order)
      if (!Number.isFinite(reach)) continue
      // Slack until the SLA is breached; negative means already late.
      const slack = order.dueAt - this.time
      const urgency = order.priority === 'express' ? 260 : 120
      // Deadline pressure dominates; proximity breaks the tie.
      const score = urgency - Math.max(0, slack) * 0.05 - reach * 0.9 + (slack < 0 ? 400 : 0)
      if (score > bestScore) {
        if (bestIndex >= 0) runnerUp = { ref: this.queue[bestIndex].ref, score: bestScore, reach: bestReach }
        bestScore = score
        bestIndex = i
        bestReach = reach
      } else if (!runnerUp || score > runnerUp.score) {
        runnerUp = { ref: order.ref, score, reach }
      }
    }

    if (bestIndex < 0) return -1
    const chosen = this.queue[bestIndex]
    const slackMin = Math.round((chosen.dueAt - this.time) / 60)
    const why =
      runnerUp && Number.isFinite(runnerUp.reach)
        ? ` — ${Math.round(runnerUp.reach - bestReach)} m closer than ${runnerUp.ref}`
        : ''
    this.think(
      agent,
      'dispatch',
      `Took ${chosen.ref} (${chosen.priority}, due in ${slackMin}m, ${Math.round(bestReach)} m away)${why}`,
    )
    return bestIndex
  }

  /**
   * Batch picking: keep adding queued orders whose stops sit close to the tour
   * already planned, until the embodiment's tote/cart capacity is reached.
   * This is where a pallet truck earns its slower pace.
   */
  private fillBatch(agent: PickerAgent, batch: Order[]): void {
    const capacity = profileFor(this.settings.pickerKind).capacityLines
    let lines = batch.reduce((s, o) => s + o.lines.length, 0)
    if (lines >= capacity) return

    for (;;) {
      if (batch.length >= MAX_BATCH_ORDERS || this.queue.length === 0) break

      const tourNodes = batch.flatMap((o) => this.nodesFor(o))
      let bestIndex = -1
      let bestGap = Infinity

      for (let i = 0; i < this.queue.length; i++) {
        const candidate = this.queue[i]
        if (lines + candidate.lines.length > capacity) continue
        let gap = Infinity
        for (const node of this.nodesFor(candidate)) {
          for (const anchor of tourNodes) {
            const d = this.ctx.distance(anchor, node)
            if (d < gap) gap = d
          }
        }
        if (gap < bestGap) {
          bestGap = gap
          bestIndex = i
        }
      }

      if (bestIndex < 0 || bestGap > BATCH_RADIUS_M) break
      const [added] = this.queue.splice(bestIndex, 1)
      batch.push(added)
      lines += added.lines.length
      this.think(
        agent,
        'batch',
        `Batched ${added.ref} (+${added.lines.length} lines) — stops ${Math.round(bestGap)} m off my tour · load ${lines}/${capacity}`,
      )
    }
  }

  private assign(agent: PickerAgent, batch: Order[]): void {
    const stops = this.stopsFor(batch)
    const route = buildRoute(
      this.ctx,
      getStrategy(this.settings.strategyId),
      stops,
      agent.homeNode,
      agent.homeNode,
    )
    agent.orders = batch
    agent.route = route
    agent.arc = 0
    agent.nextWaypoint = 0
    agent.dwellRemaining = 0
    agent.dwellTotal = 0
    agent.lift = 0
    agent.currentBinId = null
    agent.orderStartedAt = this.time
    agent.tourStartDistance = agent.distanceTraveled
    agent.plannedDistance = route.distance
    agent.linesLoaded = batch.reduce((s, o) => s + o.lines.length, 0)
    agent.blockedFor = 0
    agent.phase = route.waypoints.length > 0 ? 'traveling' : 'unloading'
    if (agent.phase === 'unloading') agent.dwellRemaining = this.unloadTime()

    for (const order of batch) this.assignedIds.add(order.id)

    const aisles = [...new Set(route.waypoints.map((w) => this.model.binsById.get(w.stop.ref)?.aisle))]
      .filter((a): a is number => a !== undefined)
      .sort((a, b) => a - b)
      .map((a) => `A${String(a + 1).padStart(2, '0')}`)

    this.think(
      agent,
      'plan',
      `Planned ${route.waypoints.length} stops over ${Math.round(route.distance)} m — ${aisles.join(' → ')}`,
    )
    if (batch.length > 1) agent.batchedTours++

    this.log(
      'assigned',
      `${batch.map((o) => o.ref).join(' + ')} → ${agent.label} · ${route.waypoints.length} stops · ${route.distance.toFixed(0)} m planned`,
    )
  }

  private stopsFor(batch: Order[]): RouteStop[] {
    const { pickTimeSec, perUnitTimeSec, pickerKind } = this.settings
    const handling = profileFor(pickerKind).handlingFactor
    const stops: RouteStop[] = []
    for (const order of batch) {
      order.lines.forEach((line, lineIndex) => {
        const bin = this.model.binsById.get(line.binId)
        if (!bin) return
        const data: StopData = { orderId: order.id, lineIndex, qty: line.qty }
        stops.push({
          node: bin.node,
          ref: bin.id,
          serviceTime:
            (pickTimeSec + perUnitTimeSec * line.qty) * handling * this.reachFactor(bin),
          data,
        })
      })
    }
    return stops
  }

  /**
   * How much longer this location takes to service than a golden-zone pick.
   *
   * The *walk* to a reserve location is identical to the pick face below it —
   * routing is bay-level, the picker stands in the same spot — so the cost of
   * bulk has to land here, in dwell, or it would be free. And it is genuinely
   * a dwell cost: climbing to the mezzanine, breaking a pallet down and
   * getting the case back to the cart is minutes of work, not metres of walk.
   * That is exactly why real facilities slot their fast movers where a picker
   * can simply turn and reach.
   */
  private reachFactor(bin: Bin): number {
    const config = this.model.config
    if (!isReserveLevel(config, bin.level)) {
      // Top of the pick face still costs a stretch or a step-ladder.
      return bin.level >= config.levels - 1 ? 1.18 : 1
    }
    // Each level up the bulk tier is another lift cycle.
    return RESERVE_PICK_FACTOR + reserveTierIndex(config, bin.level) * RESERVE_LEVEL_PENALTY
  }

  private unloadTime(): number {
    return this.settings.unloadTimeSec * profileFor(this.settings.pickerKind).unloadFactor
  }

  private speedOf(agent: PickerAgent): number {
    const profile = profileFor(this.settings.pickerKind)
    let speed = this.settings.pickerSpeed * profile.speedFactor
    if (this.settings.restBreaks && agent.kind !== 'amr') {
      // Mild, recoverable fatigue across a stint — robots are exempt.
      const wear = Math.min(1, agent.sinceBreak / WORK_BEFORE_BREAK)
      speed *= 1 - MAX_FATIGUE_LOSS * wear
    }
    return speed
  }

  // ── decision: yield, or re-plan around the blockage? ──────────────────────

  private resolveCongestion(): Map<string, number> {
    const factors = new Map<string, number>()
    const profile = profileFor(this.settings.pickerKind)
    const radius = this.settings.congestionRadius * profile.footprint
    const moving = this.agents.filter(
      (a) => a.phase === 'traveling' || a.phase === 'returning' || a.phase === 'blocked',
    )

    for (let i = 0; i < moving.length; i++) {
      for (let j = i + 1; j < moving.length; j++) {
        const a = moving[i]
        const b = moving[j]
        const dx = a.pos.x - b.pos.x
        const dy = a.pos.y - b.pos.y
        if (dx * dx + dy * dy > radius * radius) continue

        factors.set(b.id, 0)
        const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`
        const last = this.congestionPairs.get(key) ?? -Infinity
        if (this.time - last > CONGESTION_COOLDOWN) {
          this.congestionPairs.set(key, this.time)
          this.congestionTotal++
          a.congestionEvents++
          b.congestionEvents++
          this.think(b, 'wait', `Holding — ${a.label} is in the way`)
          this.log('congestion', `${a.label} and ${b.label} met in-aisle — ${b.label} yielded`)
        }
      }
    }
    return factors
  }

  /**
   * A picker that has been stuck long enough stops waiting and re-plans:
   * defer the picks in the congested aisle, work the rest of the tour, and come
   * back. Exactly what an experienced operator does, and it shows up in the
   * planned-vs-actual distance.
   */
  private attemptReroute(agent: PickerAgent): boolean {
    const route = agent.route
    if (!route || agent.nextWaypoint >= route.waypoints.length) return false

    const remaining = route.waypoints.slice(agent.nextWaypoint).map((w) => w.stop)
    if (remaining.length < 2) return false

    const blockedAisle = this.model.binsById.get(remaining[0].ref)?.aisle
    if (blockedAisle === undefined) return false

    const deferred = remaining.filter((s) => this.model.binsById.get(s.ref)?.aisle === blockedAisle)
    const rest = remaining.filter((s) => this.model.binsById.get(s.ref)?.aisle !== blockedAisle)
    if (rest.length === 0) return false

    // Resume from the next node the picker was walking towards, and credit the
    // short walk to that node so distance bookkeeping stays honest.
    const ahead = this.indexAheadOf(agent, route)
    const fromNode = route.nodePath[ahead]
    agent.distanceTraveled += Math.max(0, route.cumulative[ahead] - agent.arc)

    const reordered = [...rest, ...deferred]
    const next = buildRoute(this.ctx, getStrategy(this.settings.strategyId), reordered, fromNode, agent.homeNode)

    agent.route = next
    agent.arc = 0
    agent.nextWaypoint = 0
    // `plannedDistance` deliberately stays at the ORIGINAL plan: the whole point
    // of planned-vs-actual is to price what re-routing cost against the intent.
    agent.reroutes++
    agent.blockedFor = 0
    agent.phase = 'traveling'
    const pose = sampleRoute(next, 0)
    agent.pos = pose.pos

    this.think(
      agent,
      'reroute',
      `A${String(blockedAisle + 1).padStart(2, '0')} still blocked — deferred ${deferred.length} pick(s), working ${rest.length} elsewhere first`,
    )
    this.log('congestion', `${agent.label} re-planned around A${String(blockedAisle + 1).padStart(2, '0')}`)
    return true
  }

  /** Index of the next polyline point ahead of the agent on its current route. */
  private indexAheadOf(agent: PickerAgent, route: Route): number {
    for (let i = 0; i < route.cumulative.length; i++) {
      if (route.cumulative[i] >= agent.arc - 1e-6) return i
    }
    return route.cumulative.length - 1
  }

  // ── agent stepping ────────────────────────────────────────────────────────

  private stepAgent(agent: PickerAgent, dt: number, yieldFactor: number): void {
    if (agent.phase !== 'idle' && agent.phase !== 'break') agent.sinceBreak += dt

    switch (agent.phase) {
      case 'idle':
        agent.idleTime += dt
        return

      case 'break':
        agent.breakTime += dt
        if (this.time >= agent.breakUntil) {
          agent.sinceBreak = 0
          agent.phase = 'idle'
          this.think(agent, 'break', 'Back from break — ready for the next order')
        }
        return

      case 'awaitPack':
        this.tryHandover(agent, dt)
        return

      case 'picking':
      case 'unloading': {
        agent.dwellRemaining -= dt
        if (agent.phase === 'picking') {
          agent.pickTime += dt
          this.syncLift(agent)
        }
        if (agent.dwellRemaining > 0) return
        const overflow = -agent.dwellRemaining
        agent.dwellRemaining = 0
        agent.lift = 0
        if (agent.phase === 'unloading') {
          this.finishTour(agent)
        } else {
          this.completePick(agent)
          agent.phase = 'traveling'
          if (overflow > EPS) this.stepAgent(agent, overflow, yieldFactor)
        }
        return
      }

      case 'blocked':
      case 'returning':
      case 'traveling': {
        const route = agent.route
        if (!route) {
          agent.phase = 'idle'
          return
        }

        if (this.tryBeginPick(agent, route)) return

        if (yieldFactor <= 0) {
          agent.phase = 'blocked'
          agent.waitTime += dt
          agent.blockedFor += dt
          if (this.settings.rerouting && agent.blockedFor >= BLOCK_PATIENCE) {
            this.attemptReroute(agent)
          }
          return
        }
        agent.blockedFor = 0

        const limit =
          agent.nextWaypoint < route.waypoints.length
            ? route.waypoints[agent.nextWaypoint].arcLength
            : route.distance
        const stepLen = this.speedOf(agent) * dt * yieldFactor
        const moved = Math.min(stepLen, Math.max(0, limit - agent.arc))

        agent.arc += moved
        agent.distanceTraveled += moved
        agent.walkTime += dt
        const pose = sampleRoute(route, agent.arc)
        agent.pos = pose.pos
        if (moved > EPS) agent.heading = pose.heading

        const onLastLeg = agent.nextWaypoint >= route.waypoints.length
        agent.phase = onLastLeg ? 'returning' : 'traveling'

        if (agent.arc >= limit - 1e-4) {
          if (this.tryBeginPick(agent, route)) return
          if (onLastLeg) {
            agent.phase = 'unloading'
            agent.dwellRemaining = this.unloadTime()
          }
        }
        return
      }
    }
  }

  private tryBeginPick(agent: PickerAgent, route: Route): boolean {
    const wp = route.waypoints[agent.nextWaypoint]
    if (!wp || agent.arc < wp.arcLength - 1e-4) return false
    agent.phase = 'picking'
    agent.dwellRemaining = wp.stop.serviceTime
    agent.dwellTotal = wp.stop.serviceTime
    agent.currentBinId = wp.stop.ref
    agent.nextWaypoint++
    this.syncLift(agent)
    return true
  }

  /**
   * Raise the picker to the shelf it is working, then set it back down.
   *
   * Shaped as a trapezoid over the stop's own dwell — up over the first
   * quarter, held while the line is actually picked, down over the last
   * quarter — rather than integrated as its own free-running motion. Two
   * reasons: the picker is then guaranteed to be back on the floor at the
   * instant the dwell ends, so it can never slide across the building in
   * mid-air; and the raise/lower automatically occupies a sensible share of
   * whatever service time that stop was priced at, which for bulk is already
   * several times a pick-face stop precisely because of this climb.
   */
  private syncLift(agent: PickerAgent): void {
    const bin = agent.currentBinId ? this.model.binsById.get(agent.currentBinId) : null
    if (!bin || !isReserveLevel(this.model.config, bin.level)) {
      agent.lift = 0
      return
    }
    const total = agent.dwellTotal
    if (total <= EPS) {
      agent.lift = 0
      return
    }
    const p = Math.min(1, Math.max(0, 1 - agent.dwellRemaining / total))
    const RAMP = 0.25
    const shape = p < RAMP ? p / RAMP : p > 1 - RAMP ? (1 - p) / RAMP : 1
    // Stand at the deck, not at the face centre — the platform floor is what
    // the picker's feet are on.
    agent.lift = levelDeckTop(this.model.config, bin.level) * shape
  }

  /** Apply stock effects for the pick that just finished. */
  private completePick(agent: PickerAgent): void {
    const binId = agent.currentBinId
    agent.currentBinId = null
    agent.picksDone++
    if (!this.settings.stockDepletion || !binId) return

    const route = agent.route
    const wp = route?.waypoints[agent.nextWaypoint - 1]
    const data = wp?.stop.data as StopData | undefined
    const bin = this.model.binsById.get(binId)
    if (!bin || !data) return

    const wanted = data.qty
    const taken = Math.min(wanted, bin.sku.stock)
    bin.sku.stock -= taken

    if (taken < wanted) {
      agent.shortPicks++
      this.think(
        agent,
        'short',
        `Short at ${bin.code} — took ${taken} of ${wanted}, flagged for replen`,
      )
      this.log('short', `${agent.label} short-picked ${bin.code} (${taken}/${wanted} available)`)
    }
    if (bin.sku.stock <= bin.sku.replenPoint) this.replenAlerts.add(bin.id)
  }

  /**
   * The picker's tour ends at the pack bench, but the order's journey does not:
   * each picked order becomes a pack job, and the picker is only free once the
   * pack line has actually accepted the totes.
   */
  private finishTour(agent: PickerAgent): void {
    const route = agent.route
    const batch = agent.orders
    if (route && batch.length > 0) {
      const duration = this.time - agent.orderStartedAt
      const actual = agent.distanceTraveled - agent.tourStartDistance
      const totalLines = batch.reduce((s, o) => s + o.lines.length, 0) || 1
      const tourId = this.tourSeq++

      for (const order of batch) {
        const share = order.lines.length / totalLines
        agent.ordersDone++
        agent.totalOrderTime += duration
        agent.pendingJobs.push({
          orderId: order.id,
          ref: order.ref,
          channel: order.channel,
          priority: order.priority,
          lines: order.lines.length,
          units: order.lines.reduce((s, l) => s + l.qty, 0),
          agentId: agent.id,
          agentLabel: agent.label,
          strategyId: route.strategyId,
          tourId,
          batchSize: batch.length,
          distance: actual * share,
          planned: agent.plannedDistance * share,
          assignedAt: agent.orderStartedAt,
          pickedAt: this.time,
          dueAt: order.dueAt,
        })
      }

      const drift = actual - agent.plannedDistance
      this.think(
        agent,
        'done',
        `Picked ${batch.length} order(s) — ${Math.round(actual)} m walked${
          Math.abs(drift) > 3 ? ` (${drift > 0 ? '+' : ''}${Math.round(drift)} m vs plan)` : ''
        }, ${formatDuration(duration)}`,
      )
      this.log(
        'handoff',
        `${batch.map((o) => o.ref).join(' + ')} picked by ${agent.label} · ${actual.toFixed(0)} m · ${formatDuration(duration)} → pack`,
      )
    }

    agent.orders = []
    agent.route = null
    agent.arc = 0
    agent.nextWaypoint = 0
    agent.currentBinId = null
    agent.linesLoaded = 0
    agent.blockedFor = 0
    agent.phase = 'awaitPack'
    this.tryHandover(agent, 0)
  }

  /**
   * Move the picked totes onto the pack line.
   *
   * The induction buffer is finite on purpose: when packing cannot keep up, the
   * picker stands at the bench holding totes instead of walking off for the next
   * order. That back-pressure is the whole reason a pack bottleneck shows up in
   * picker utilisation rather than hiding in an infinite queue.
   */
  private tryHandover(agent: PickerAgent, dt: number): void {
    const accepted: PackJob[] = []
    while (agent.pendingJobs.length > 0) {
      const job = agent.pendingJobs[0]
      if (!this.packLine.induct(job)) break
      agent.pendingJobs.shift()
      this.assignedIds.delete(job.orderId)
      accepted.push(job)
    }

    if (accepted.length > 0) {
      const lines = accepted.reduce((s, j) => s + j.lines, 0)
      this.think(
        agent,
        'pack',
        `Inducted ${accepted.length} order(s) / ${lines} lines at pack — buffer now ${this.packLine.bufferDepth}`,
      )
    }

    if (agent.pendingJobs.length > 0) {
      if (agent.blockedFor === 0) {
        this.think(
          agent,
          'wait',
          `Pack buffer full (${this.packLine.bufferDepth} totes) — holding ${agent.pendingJobs.length} order(s) at the bench`,
        )
        this.log('pack', `${agent.label} is blocked at pack — induction buffer full`)
      }
      agent.blockedFor += dt
      agent.waitTime += dt
      agent.packWaitTime += dt
      agent.phase = 'awaitPack'
      return
    }

    agent.blockedFor = 0
    this.releasePicker(agent)
  }

  /** Break decision once the totes are gone and the picker is free again. */
  private releasePicker(agent: PickerAgent): void {
    if (this.settings.restBreaks && agent.sinceBreak >= WORK_BEFORE_BREAK) {
      agent.phase = 'break'
      agent.breakUntil = this.time + BREAK_DURATION
      this.think(
        agent,
        'break',
        `${Math.round(agent.sinceBreak / 60)} min worked — taking a ${BREAK_DURATION / 60} min break`,
      )
      this.log('break', `${agent.label} on a scheduled break`)
      return
    }
    agent.phase = 'idle'
  }

  /** A parcel reached its dock: the order is finally out of the building's hands. */
  private recordCompletion(record: CompletedOrder): void {
    this.completed.push(record)
    this.log(
      'completed',
      `${record.ref} staged at ${record.dock} · ${record.cartons} carton${record.cartons > 1 ? 's' : ''} · ${formatDuration(record.duration)} end to end`,
    )
    if (!record.onTime) {
      this.log('late', `${record.ref} shipped ${formatDuration(record.finishedAt - record.dueAt)} past SLA`)
    }
  }

  private sampleSeries(): void {
    if (this.time < this.nextSeriesAt) return
    this.nextSeriesAt += SERIES_INTERVAL
    this.series.push({
      t: Math.round(this.time),
      completed: this.completed.length,
      distance: Math.round(this.agents.reduce((s, a) => s + a.distanceTraveled, 0)),
    })
    if (this.series.length > MAX_SERIES_POINTS) this.series.shift()
  }

  private log(kind: SimEvent['kind'], message: string): void {
    this.events.push({ id: this.eventSeq++, at: this.time, kind, message })
    if (this.events.length > 80) this.events.shift()
  }

  // ── metrics snapshot ──────────────────────────────────────────────────────

  /**
   * The picker's tour as a task list.
   *
   * Built from the route rather than from the orders, because the route is what
   * the picker is actually walking: a batched tour interleaves lines from several
   * orders, and the sequence a strategy chose is the whole point of the exercise.
   * `nextWaypoint` is the count of serviced stops, so it is also the index of the
   * one being worked on right now.
   */
  private taskList(agent: PickerAgent): PickTask[] {
    const route = agent.route
    if (!route) return []
    const refById = new Map(agent.orders.map((o) => [o.id, o.ref]))

    const config = this.model.config
    return route.waypoints.map((wp) => {
      const bin = this.model.binsById.get(wp.stop.ref)
      const data = wp.stop.data as StopData | undefined
      const reserve = bin ? isReserveLevel(config, bin.level) : false
      return {
        sequence: wp.sequence,
        binId: wp.stop.ref,
        code: bin?.code ?? wp.stop.ref,
        aisle: bin?.aisle ?? 0,
        reserve,
        levelInTier: bin ? (reserve ? reserveTierIndex(config, bin.level) : bin.level) + 1 : 1,
        sku: bin?.sku.id ?? '—',
        skuName: bin?.sku.name ?? 'Unknown line',
        qty: data?.qty ?? 0,
        orderRef: (data && refById.get(data.orderId)) ?? '—',
        status:
          wp.sequence <= agent.nextWaypoint
            ? 'done'
            : wp.sequence === agent.nextWaypoint + 1
              ? 'current'
              : 'pending',
        arcLength: wp.arcLength,
      }
    })
  }

  metrics(): SimMetrics {
    const elapsed = Math.max(this.time, 1e-3)
    const totalDistance = this.agents.reduce((s, a) => s + a.distanceTraveled, 0)
    const totalPicks = this.agents.reduce((s, a) => s + a.picksDone, 0)
    const busy = this.agents.reduce((s, a) => s + (elapsed - a.idleTime), 0)
    const ordersCompleted = this.completed.length
    const totalOrderTime = this.completed.reduce((s, c) => s + c.duration, 0)
    const lines = this.completed.reduce((s, c) => s + c.picks, 0)
    const onTime = this.completed.filter((c) => c.onTime).length
    // Average orders per completed TOUR — averaging batchSize across orders
    // would over-weight the big batches and overstate it.
    const tours = new Set(this.completed.map((c) => c.tourId)).size

    const agents: AgentMetrics[] = this.agents.map((a) => ({
      id: a.id,
      label: a.label,
      color: a.color,
      kind: a.kind,
      phase: a.phase,
      distance: a.distanceTraveled,
      picks: a.picksDone,
      orders: a.ordersDone,
      avgOrderTime: a.ordersDone > 0 ? a.totalOrderTime / a.ordersDone : 0,
      utilisation: elapsed > 0 ? Math.max(0, Math.min(1, (elapsed - a.idleTime) / elapsed)) : 0,
      congestionEvents: a.congestionEvents,
      shortPicks: a.shortPicks,
      reroutes: a.reroutes,
      orderRefs: a.orders.map((o) => o.ref),
      progress: a.route && a.route.distance > 0 ? Math.min(1, a.arc / a.route.distance) : 0,
      routeStops: a.route?.waypoints.length ?? 0,
      stopsDone: a.nextWaypoint,
      linesLoaded: a.linesLoaded,
      capacityLines: a.capacityLines,
      thoughts: a.thoughts.slice().reverse(),
      tasks: this.taskList(a),
      routeDistance: a.route?.distance ?? 0,
      tourDistance: Math.max(0, a.distanceTraveled - a.tourStartDistance),
      walkTime: a.walkTime,
      pickTime: a.pickTime,
      waitTime: a.waitTime,
      idleTime: a.idleTime,
      breakTime: a.breakTime,
    }))

    const pack = this.packLine.metrics(elapsed)

    return {
      time: this.time,
      running: this.running,
      totalDistance,
      // Compared like-for-like: both sides cover completed tours only, so
      // work still in flight can't masquerade as re-route drift.
      totalActual: this.completed.reduce((s, c) => s + c.distance, 0),
      totalPlanned: this.completed.reduce((s, c) => s + c.planned, 0),
      totalPicks,
      ordersCompleted,
      ordersPending: this.queue.length + (this.orders.length - this.releaseCursor),
      // Everything inside the four walls that is neither queued nor shipped:
      // with a picker, on a bench, or riding the conveyor.
      ordersInProgress:
        this.assignedIds.size + pack.ordersAwaitingPack + pack.ordersPacking + pack.parcelsInTransit,
      ordersTotal: this.orders.length,
      ordersPicked: pack.ordersPicked,
      ordersAwaitingPack: pack.ordersAwaitingPack,
      ordersPacking: pack.ordersPacking,
      parcelsInTransit: pack.parcelsInTransit,
      parcelsStaged: pack.parcelsStaged,
      parcelsPacked: pack.parcelsPacked,
      parcelsDispatched: pack.parcelsDispatched,
      cartonsPacked: pack.cartonsPacked,
      trailersSealed: pack.trailersSealed,
      avgPackSec: pack.avgPackSec,
      avgConveySec: pack.avgConveySec,
      packUtilisation: pack.packUtilisation,
      packBufferPeak: pack.packBufferPeak,
      mergeBlocks: pack.mergeBlocks,
      packWaitSeconds: this.agents.reduce((s, a) => s + a.packWaitTime, 0),
      packStations: pack.stations,
      docks: pack.docks,
      // Snapshot, not the live array: React reads this while the engine keeps
      // moving parcels every frame.
      parcels: this.packLine.parcels.slice(),
      avgOrderTime: ordersCompleted > 0 ? totalOrderTime / ordersCompleted : 0,
      avgDistancePerOrder: ordersCompleted > 0 ? totalDistance / ordersCompleted : 0,
      congestionEvents: this.congestionTotal,
      utilisation: this.agents.length > 0 ? busy / (elapsed * this.agents.length) : 0,
      throughput: (ordersCompleted / elapsed) * 3600,
      linesPerHour: (lines / elapsed) * 3600,
      onTimeRate: ordersCompleted > 0 ? onTime / ordersCompleted : 1,
      ordersLate: ordersCompleted - onTime,
      shortPicks: this.agents.reduce((s, a) => s + a.shortPicks, 0),
      reroutes: this.agents.reduce((s, a) => s + a.reroutes, 0),
      batchedTours: this.agents.reduce((s, a) => s + a.batchedTours, 0),
      avgBatchSize: tours > 0 ? ordersCompleted / tours : 0,
      replenAlerts: this.replenAlerts.size,
      agents,
      series: this.series.slice(),
      recent: this.completed.slice(-8).reverse(),
      events: this.events.slice(-40).reverse(),
    }
  }
}

export function clampAgents(count: number): number {
  return Math.max(1, Math.min(MAX_AGENTS, Math.round(count)))
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}h ${String(m % 60).padStart(2, '0')}m`
  return `${m}m ${String(s % 60).padStart(2, '0')}s`
}
