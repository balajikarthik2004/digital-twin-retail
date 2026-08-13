import {
  conveyorPathLength,
  sampleConveyor,
  type ConveyorNetwork,
  type Vec3,
} from '../warehouse/conveyor'
import type { WarehouseModel } from '../warehouse/types'
import type {
  CompletedOrder,
  DockMetrics,
  Order,
  PackJob,
  PackStation,
  PackStationMetrics,
  Parcel,
  SimEvent,
  SimSettings,
} from './types'

/**
 * Pack-out and dispatch.
 *
 * Picking is only half the job: a picked tote is not a shipment. This models
 * what happens after the picker walks back — the totes queue at induction, a
 * manned bench cartonises the order, the parcel merges onto the takeaway
 * conveyor, the sorter diverts it to the door its channel ships from, and it
 * stacks until a trailer is sealed.
 *
 * Two things make it a simulation rather than a delay: the induction buffer is
 * finite, so a slow pack wall pushes back on the pickers, and the conveyor is
 * a shared resource, so a parcel can be held at a merge point while a gap
 * arrives. Both are the classic ways a DC's downstream capacity, not its
 * pickers, ends up setting throughput.
 *
 * Deliberately owns no clock: the engine steps it, so packing runs on exactly
 * the same fixed slices as the picking floor.
 */

export interface PackLineHooks {
  log(kind: SimEvent['kind'], message: string): void
  complete(record: CompletedOrder): void
}

export interface PackLineMetrics {
  ordersPicked: number
  ordersAwaitingPack: number
  ordersPacking: number
  parcelsInTransit: number
  parcelsStaged: number
  parcelsPacked: number
  parcelsDispatched: number
  cartonsPacked: number
  trailersSealed: number
  avgPackSec: number
  avgConveySec: number
  packUtilisation: number
  packBufferPeak: number
  mergeBlocks: number
  stations: PackStationMetrics[]
  docks: DockMetrics[]
}

/** Which door each sales channel ships from — the sorter's routing table. */
const CHANNEL_SEQUENCE: Order['channel'][] = [
  'Ecommerce',
  'Click & Collect',
  'Store Replen',
  'Wholesale',
]

/** Minimum spacing between parcels on the belt, metres. */
const MIN_GAP = 1.15
/**
 * Parcels per trailer, and how long a part-full trailer waits before it seals.
 *
 * Exported because a door's loading progress is only meaningful against them:
 * "6 staged" says nothing on its own, "6 of 16, sealing in 2m 10s" is the state
 * of the door. The dock inspector reads both.
 */
export const TRAILER_CAPACITY = 16
export const TRAILER_DWELL = 240
/** Walking pace when parcels are hand-trucked instead of conveyed, m/s. */
const MANUAL_SPEED = 1.05
/** Extra seconds of load/unload handling on a hand-trucked parcel. */
const MANUAL_HANDLING = 14
/** An extra carton costs a fraction of the fixed set-up again. */
const EXTRA_CARTON_FACTOR = 0.55

interface DockLane {
  id: string
  label: string
  channels: Order['channel'][]
  staged: Parcel[]
  dispatched: number
  trailers: number
  cartons: number
  /** Sim time the oldest currently-staged parcel arrived. */
  oldestStagedAt: number
}

export class PackLine {
  stations: PackStation[] = []
  parcels: Parcel[] = []
  /** Shared induction buffer: totes waiting for a free bench. */
  queue: PackJob[] = []

  private net: ConveyorNetwork
  private settings: SimSettings
  private hooks: PackLineHooks
  private docks: DockLane[] = []
  /** Picking history, kept alive until the parcel lands so the record is whole. */
  private jobByParcel = new Map<string, { job: PackJob; packSeconds: number }>()
  /** No conveyor in this layout — everything is hand-trucked. */
  private manualOnly = false

  private parcelSeq = 1
  private ordersInducted = 0
  private parcelsPacked = 0
  private cartonsPacked = 0
  private parcelsDispatched = 0
  private trailersSealed = 0
  private mergeBlocks = 0
  private bufferPeak = 0
  private totalPackSeconds = 0
  private totalConveySeconds = 0
  private completedCount = 0

  constructor(model: WarehouseModel, settings: SimSettings, hooks: PackLineHooks) {
    this.net = model.conveyor
    this.settings = settings
    this.hooks = hooks
    this.manualOnly = this.net.spurs.length === 0 || this.net.chutes.length === 0

    const packFacilities = model.facilities.filter((f) => f.kind === 'pack')
    this.stations = packFacilities.map((facility, index) => ({
      id: facility.id,
      index,
      label: facility.label,
      pos: { ...facility.pos },
      staffed: true,
      phase: 'idle',
      job: null,
      remaining: 0,
      cycleLength: 0,
      // Benches are not identical: a 7% spread is enough to make the slowest
      // one visible as a queue former without turning it into a caricature.
      efficiency: 1 + ((index % 3) - 1) * 0.07,
      holding: null,
      ordersPacked: 0,
      cartonsPacked: 0,
      busyTime: 0,
      idleTime: 0,
      blockedTime: 0,
      totalPackTime: 0,
    }))

    const dockFacilities = model.facilities.filter((f) => f.kind === 'dock')
    this.docks = dockFacilities.map((facility, index) => ({
      id: facility.id,
      label: facility.label,
      channels: CHANNEL_SEQUENCE.filter((_, c) => c % dockFacilities.length === index),
      staged: [],
      dispatched: 0,
      trailers: 0,
      cartons: 0,
      oldestStagedAt: 0,
    }))

    this.applyStaffing()
  }

  // ── configuration ─────────────────────────────────────────────────────────

  configure(settings: SimSettings): void {
    this.settings = settings
    this.applyStaffing()
  }

  /** Benches beyond the staffing level stay closed; they finish work in hand first. */
  private applyStaffing(): void {
    const manned = Math.max(1, Math.min(this.stations.length, Math.round(this.settings.packStaff)))
    for (const station of this.stations) {
      station.staffed = station.index < manned
      if (!station.staffed && !station.job && !station.holding) station.phase = 'unstaffed'
      if (station.staffed && station.phase === 'unstaffed') station.phase = 'idle'
    }
  }

  get staffedCount(): number {
    return this.stations.filter((s) => s.staffed).length
  }

  reset(): void {
    this.parcels = []
    this.queue = []
    this.jobByParcel.clear()
    for (const station of this.stations) {
      station.job = null
      station.holding = null
      station.remaining = 0
      station.cycleLength = 0
      station.phase = station.staffed ? 'idle' : 'unstaffed'
      station.ordersPacked = 0
      station.cartonsPacked = 0
      station.busyTime = 0
      station.idleTime = 0
      station.blockedTime = 0
      station.totalPackTime = 0
    }
    for (const dock of this.docks) {
      dock.staged = []
      dock.dispatched = 0
      dock.trailers = 0
      dock.cartons = 0
      dock.oldestStagedAt = 0
    }
    this.parcelSeq = 1
    this.ordersInducted = 0
    this.parcelsPacked = 0
    this.cartonsPacked = 0
    this.parcelsDispatched = 0
    this.trailersSealed = 0
    this.mergeBlocks = 0
    this.bufferPeak = 0
    this.totalPackSeconds = 0
    this.totalConveySeconds = 0
    this.completedCount = 0
  }

  /** Anything still in the pack/dispatch pipeline that the clock must wait for. */
  get busy(): boolean {
    return (
      this.queue.length > 0 ||
      this.stations.some((s) => s.job !== null || s.holding !== null) ||
      this.parcels.some((p) => p.stage === 'conveying')
    )
  }

  get bufferDepth(): number {
    return this.queue.length
  }

  /** Buffer slots available right now — 0 means pickers have to hold their totes. */
  get bufferFree(): boolean {
    return this.queue.length < Math.max(1, Math.round(this.settings.packBufferLimit))
  }

  // ── induction ─────────────────────────────────────────────────────────────

  /**
   * Take a picked order into the pack buffer.
   *
   * @param force accept even when the buffer is full — used when a picker is
   * removed from the floor mid-tour, so its work is never silently lost.
   * @returns false when the buffer is full and the picker must keep holding.
   */
  induct(job: PackJob, force = false): boolean {
    if (!force && !this.bufferFree) return false
    this.queue.push(job)
    this.ordersInducted++
    this.bufferPeak = Math.max(this.bufferPeak, this.queue.length)
    return true
  }

  // ── stepping ──────────────────────────────────────────────────────────────

  step(dt: number, time: number): void {
    for (const station of this.stations) this.stepStation(station, dt, time)
    this.stepParcels(dt, time)
    this.stepTrailers(time, false)
  }

  private stepStation(station: PackStation, dt: number, time: number): void {
    // A finished parcel must clear the bench before the next order starts —
    // this is what turns a conveyor jam into a pack-wall stoppage.
    if (station.holding) {
      if (this.releaseParcel(station.holding)) {
        station.holding = null
        station.phase = station.job ? 'packing' : 'idle'
      } else {
        station.blockedTime += dt
        station.phase = 'mergeBlocked'
        return
      }
    }

    if (!station.staffed) {
      if (!station.job) {
        station.phase = 'unstaffed'
        return
      }
    }

    if (station.job) {
      station.remaining -= dt
      station.busyTime += dt
      station.phase = 'packing'
      if (station.remaining > 0) return
      this.finishPack(station, time)
      if (station.holding || !station.staffed) return
    }

    const job = this.takeNextJob()
    if (!job) {
      if (station.staffed) {
        station.idleTime += dt
        station.phase = 'idle'
      }
      return
    }
    this.startPack(station, job)
  }

  /** Express first, then oldest tote — the same rule the pick queue uses. */
  private takeNextJob(): PackJob | null {
    if (this.queue.length === 0) return null
    let best = 0
    for (let i = 1; i < this.queue.length; i++) {
      const a = this.queue[i]
      const b = this.queue[best]
      const aExpress = a.priority === 'express'
      const bExpress = b.priority === 'express'
      if (aExpress !== bExpress ? aExpress : a.pickedAt < b.pickedAt) best = i
    }
    return this.queue.splice(best, 1)[0]
  }

  private startPack(station: PackStation, job: PackJob): void {
    const { packSetupSec, packPerLineSec, packPerUnitSec } = this.settings
    const cartons = this.cartonsFor(job)
    const setup = packSetupSec * (1 + (cartons - 1) * EXTRA_CARTON_FACTOR)
    const seconds =
      (setup + packPerLineSec * job.lines + packPerUnitSec * job.units) / station.efficiency

    station.job = job
    station.cycleLength = seconds
    station.remaining = seconds
    station.phase = 'packing'
  }

  private cartonsFor(job: PackJob): number {
    const perCarton = Math.max(1, Math.round(this.settings.unitsPerCarton))
    return Math.max(1, Math.ceil(job.units / perCarton))
  }

  private finishPack(station: PackStation, time: number): void {
    const job = station.job
    if (!job) return
    const overrun = -station.remaining
    station.job = null
    station.remaining = 0

    const cartons = this.cartonsFor(job)
    const packSeconds = station.cycleLength
    station.ordersPacked++
    station.cartonsPacked += cartons
    station.totalPackTime += packSeconds
    this.parcelsPacked++
    this.cartonsPacked += cartons
    this.totalPackSeconds += packSeconds

    const dockIndex = this.dockIndexFor(job.channel)
    const dock = this.docks[dockIndex]
    const manual = this.manualOnly || !this.settings.conveyorSortation
    const parcel: Parcel = {
      id: `parcel-${this.parcelSeq}`,
      seq: this.parcelSeq++,
      orderId: job.orderId,
      ref: job.ref,
      channel: job.channel,
      priority: job.priority,
      cartons,
      // Cosmetic but consistent: units drive the mass, cartons add tare.
      weightKg: Math.round((job.units * 0.62 + cartons * 0.45) * 10) / 10,
      stationIndex: station.index,
      stationLabel: station.label,
      dockIndex,
      dockLabel: dock?.label ?? 'Dock',
      stage: 'conveying',
      arc: 0,
      pathLength: manual
        ? this.manualDistance(station, dockIndex)
        : conveyorPathLength(this.net, station.index, dockIndex),
      pos: this.spurStart(station, dockIndex),
      heading: 0,
      blocked: false,
      manual,
      packedAt: time - overrun,
      stagedAt: 0,
      stackIndex: 0,
    }

    // Carry the picking history forward on the parcel's job so the completion
    // record can report the whole lifecycle.
    this.jobByParcel.set(parcel.id, { job, packSeconds })

    this.hooks.log(
      'pack',
      `${job.ref} packed at ${station.label} · ${cartons} carton${cartons > 1 ? 's' : ''} · ${parcel.weightKg} kg → ${parcel.dockLabel}`,
    )

    if (!this.releaseParcel(parcel)) {
      station.holding = parcel
      station.phase = 'mergeBlocked'
      this.mergeBlocks++
      this.hooks.log('pack', `${station.label} holding ${job.ref} — no gap on the takeaway conveyor`)
    }
  }

  /** Put a parcel on the belt if its spur is clear. */
  private releaseParcel(parcel: Parcel): boolean {
    if (!parcel.manual) {
      const spur = this.net.spurs[parcel.stationIndex]
      const occupied = this.parcels.some(
        (p) =>
          p.stage === 'conveying' &&
          !p.manual &&
          p.stationIndex === parcel.stationIndex &&
          p.arc < (spur?.length ?? 0) + MIN_GAP,
      )
      if (occupied) return false
    }
    this.parcels.push(parcel)
    return true
  }

  private stepParcels(dt: number, time: number): void {
    const speed = Math.max(0.05, this.settings.conveyorSpeed)
    for (const parcel of this.parcels) {
      if (parcel.stage !== 'conveying') continue

      if (parcel.manual) {
        // Hand-trucked: a straight run across the apron at walking pace.
        parcel.arc = Math.min(parcel.arc + MANUAL_SPEED * dt, parcel.pathLength)
        const from = this.stations[parcel.stationIndex]
        const to = this.net.chutes[parcel.dockIndex]?.stagePos
        if (from && to) {
          const t = parcel.pathLength > 0 ? parcel.arc / parcel.pathLength : 1
          parcel.pos = {
            x: from.pos.x + (to.x - from.pos.x) * t,
            y: 0.72,
            z: from.pos.y + (to.z - from.pos.y) * t,
          }
          parcel.heading = Math.atan2(to.x - from.pos.x, to.z - from.pos.y)
        }
        if (parcel.arc >= parcel.pathLength - 1e-6) this.stageParcel(parcel, time)
        continue
      }

      const spur = this.net.spurs[parcel.stationIndex]
      const spurLength = spur?.length ?? 0
      let next = parcel.arc + speed * dt

      // The merge is the only place a parcel can be blocked: once on the trunk
      // everything moves at belt speed, so gaps are preserved by construction.
      if (parcel.arc <= spurLength && next > spurLength && !this.mergeClear(parcel)) {
        next = spurLength
        if (!parcel.blocked) {
          parcel.blocked = true
          this.mergeBlocks++
        }
      } else {
        parcel.blocked = false
      }

      parcel.arc = Math.min(next, parcel.pathLength)
      const pose = sampleConveyor(this.net, parcel.stationIndex, parcel.dockIndex, parcel.arc)
      parcel.pos = pose.pos
      parcel.heading = pose.heading

      if (parcel.arc >= parcel.pathLength - 1e-6) this.stageParcel(parcel, time)
    }
  }

  /** Is there a MIN_GAP-wide window on the trunk at this parcel's merge point? */
  private mergeClear(entrant: Parcel): boolean {
    const spur = this.net.spurs[entrant.stationIndex]
    if (!spur) return true
    for (const other of this.parcels) {
      if (other === entrant || other.stage !== 'conveying' || other.manual) continue
      const arc = this.trunkArcOf(other)
      if (arc === null) continue
      if (Math.abs(arc - spur.mergeArc) < MIN_GAP) return false
    }
    return true
  }

  /** Position of a parcel in trunk arc space, or null when it is off the trunk. */
  private trunkArcOf(parcel: Parcel): number | null {
    const spur = this.net.spurs[parcel.stationIndex]
    const chute = this.net.chutes[parcel.dockIndex]
    if (!spur || !chute) return null
    const onTrunk = parcel.arc - spur.length
    if (onTrunk < 0) return null
    const span = Math.max(0, chute.divertArc - spur.mergeArc)
    if (onTrunk > span) return null
    return spur.mergeArc + onTrunk
  }

  private stageParcel(parcel: Parcel, time: number): void {
    const dock = this.docks[parcel.dockIndex]
    parcel.stage = 'staged'
    parcel.stagedAt = time
    parcel.blocked = false
    parcel.arc = parcel.pathLength

    if (dock) {
      if (dock.staged.length === 0) dock.oldestStagedAt = time
      parcel.stackIndex = dock.staged.length
      dock.staged.push(parcel)
      parcel.pos = this.stackPos(parcel.dockIndex, parcel.stackIndex)
    }
    this.totalConveySeconds += parcel.stagedAt - parcel.packedAt

    const entry = this.jobByParcel.get(parcel.id)
    this.jobByParcel.delete(parcel.id)
    if (!entry) return
    const { job, packSeconds } = entry
    this.completedCount++
    this.hooks.complete({
      orderId: job.orderId,
      ref: job.ref,
      agentId: job.agentId,
      strategyId: job.strategyId,
      tourId: job.tourId,
      distance: job.distance,
      planned: job.planned,
      duration: time - job.assignedAt,
      pickSeconds: job.pickedAt - job.assignedAt,
      packSeconds,
      conveySeconds: parcel.stagedAt - parcel.packedAt,
      picks: job.lines,
      shorts: 0,
      cartons: parcel.cartons,
      packStation: parcel.stationLabel,
      dock: parcel.dockLabel,
      finishedAt: time,
      dueAt: job.dueAt,
      onTime: time <= job.dueAt,
      batchSize: job.batchSize,
      pickPath: job.pickPath,
    })
  }

  /**
   * Seal trailers. A door ships when it has a full load, or when the oldest
   * parcel has waited long enough that holding the door open costs more than
   * the empty space does.
   *
   * @param flush seal every part-full trailer, used when the wave is drained.
   */
  stepTrailers(time: number, flush: boolean): void {
    for (const dock of this.docks) {
      if (dock.staged.length === 0) continue
      const full = dock.staged.length >= TRAILER_CAPACITY
      const stale = time - dock.oldestStagedAt >= TRAILER_DWELL
      if (!full && !stale && !flush) continue

      const load = dock.staged
      const cartons = load.reduce((s, p) => s + p.cartons, 0)
      for (const parcel of load) parcel.stage = 'dispatched'
      this.parcels = this.parcels.filter((p) => p.stage !== 'dispatched')
      dock.staged = []
      dock.dispatched += load.length
      dock.cartons += cartons
      dock.trailers++
      dock.oldestStagedAt = time
      this.parcelsDispatched += load.length
      this.trailersSealed++
      this.hooks.log(
        'dispatch',
        `${dock.label} trailer sealed — ${load.length} parcels · ${cartons} cartons away`,
      )
    }
  }

  // ── geometry helpers ──────────────────────────────────────────────────────

  private dockIndexFor(channel: Order['channel']): number {
    if (this.docks.length === 0) return 0
    const seq = CHANNEL_SEQUENCE.indexOf(channel)
    return (seq < 0 ? 0 : seq) % this.docks.length
  }

  private spurStart(station: PackStation, dockIndex: number): Vec3 {
    const spur = this.net.spurs[station.index]
    if (spur && spur.polyline.length > 0) return { ...spur.polyline[0] }
    const chute = this.net.chutes[dockIndex]
    return chute ? { ...chute.stagePos } : { x: station.pos.x, y: 1, z: station.pos.y }
  }

  /** Straight-line trip a hand truck makes when the conveyor is switched off. */
  private manualDistance(station: PackStation, dockIndex: number): number {
    const chute = this.net.chutes[dockIndex]
    if (!chute) return MANUAL_SPEED * MANUAL_HANDLING
    const dx = chute.stagePos.x - station.pos.x
    const dz = chute.stagePos.z - station.pos.y
    return Math.hypot(dx, dz) + MANUAL_SPEED * MANUAL_HANDLING
  }

  private stackPos(dockIndex: number, index: number): Vec3 {
    const chute = this.net.chutes[dockIndex]
    const base = chute?.stagePos ?? { x: 0, y: 0.16, z: 0 }
    const col = index % 3
    const row = Math.floor(index / 3) % 2
    const layer = Math.floor(index / 6)
    return {
      x: base.x + (col - 1) * 0.52,
      y: 0.17 + layer * 0.34,
      z: base.z + (row - 0.5) * 0.56,
    }
  }

  // ── metrics ───────────────────────────────────────────────────────────────

  metrics(elapsed: number): PackLineMetrics {
    const inbound = new Map<number, number>()
    let inTransit = 0
    let staged = 0
    for (const parcel of this.parcels) {
      if (parcel.stage === 'conveying') {
        inTransit++
        inbound.set(parcel.dockIndex, (inbound.get(parcel.dockIndex) ?? 0) + 1)
      } else if (parcel.stage === 'staged') staged++
    }

    const stations: PackStationMetrics[] = this.stations.map((s) => {
      const tracked = Math.max(1e-6, s.busyTime + s.idleTime + s.blockedTime)
      return {
        id: s.id,
        label: s.label,
        phase: s.phase,
        staffed: s.staffed,
        ref: s.job?.ref ?? s.holding?.ref ?? null,
        channel: s.job?.channel ?? s.holding?.channel ?? null,
        progress: s.job && s.cycleLength > 0 ? 1 - Math.max(0, s.remaining) / s.cycleLength : 0,
        ordersPacked: s.ordersPacked,
        cartonsPacked: s.cartonsPacked,
        avgPackSec: s.ordersPacked > 0 ? s.totalPackTime / s.ordersPacked : 0,
        utilisation: s.staffed ? Math.min(1, s.busyTime / tracked) : 0,
        blockedShare: s.staffed ? Math.min(1, s.blockedTime / tracked) : 0,
      }
    })

    const manned = this.stations.filter((s) => s.staffed)
    const mannedSeconds = Math.max(1e-6, elapsed * Math.max(1, manned.length))
    const packBusy = manned.reduce((sum, s) => sum + s.busyTime, 0)

    const docks: DockMetrics[] = this.docks.map((d, i) => ({
      id: d.id,
      label: d.label,
      channels: d.channels,
      inbound: inbound.get(i) ?? 0,
      staged: d.staged.length,
      dispatched: d.dispatched,
      trailers: d.trailers,
      cartons: d.cartons,
      stagedCartons: d.staged.reduce((sum, p) => sum + p.cartons, 0),
      oldestStagedAt: d.staged.length > 0 ? d.oldestStagedAt : 0,
    }))

    return {
      ordersPicked: this.ordersInducted,
      ordersAwaitingPack: this.queue.length,
      ordersPacking: this.stations.filter((s) => s.job !== null).length,
      parcelsInTransit: inTransit,
      parcelsStaged: staged,
      parcelsPacked: this.parcelsPacked,
      parcelsDispatched: this.parcelsDispatched,
      cartonsPacked: this.cartonsPacked,
      trailersSealed: this.trailersSealed,
      avgPackSec: this.parcelsPacked > 0 ? this.totalPackSeconds / this.parcelsPacked : 0,
      avgConveySec: this.completedCount > 0 ? this.totalConveySeconds / this.completedCount : 0,
      packUtilisation: Math.min(1, packBusy / mannedSeconds),
      packBufferPeak: this.bufferPeak,
      mergeBlocks: this.mergeBlocks,
      stations,
      docks,
    }
  }
}
