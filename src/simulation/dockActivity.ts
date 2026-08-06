import { outstandingUnits, receiptStatus, type Receipt, type ReceiptStatus } from '../inbound/types'
import type { WarehouseModel } from '../warehouse/types'
import { TRAILER_CAPACITY, TRAILER_DWELL } from './packLine'
import type { DockMetrics, Order, Parcel, SimMetrics } from './types'

/**
 * What a dock door is doing right now.
 *
 * A door is the one place in the building where both halves of the operation
 * meet: trailers back onto it to be unloaded, and trailers are loaded off it to
 * ship. Everywhere else in this twin those two flows live in separate panels —
 * inbound on the left, pack-out on the right — so the door itself was the only
 * object you could look at and learn nothing from.
 *
 * This is the join. It is a pure derivation over state that already exists:
 * goods-in receipts for the inbound side, the pack line's own dock metrics and
 * live parcels for the outbound side. Nothing here invents a number, and both
 * the 3D door display and the inspector card read the same object, so the board
 * on the door can never disagree with the card that describes it.
 */

/** Which way goods are moving through a door at this instant. */
export type DockFlow = 'inbound' | 'outbound' | 'idle'

export interface DockOutboundWork {
  /** Sales channels the sorter routes to this door. */
  channels: Order['channel'][]
  /** Parcels on the belt right now whose divert is this door. */
  enRoute: number
  /** Parcels stacked on the pad, waiting for the trailer to seal. */
  staged: number
  /** Parcels a trailer holds — {@link TRAILER_CAPACITY}. */
  capacity: number
  /** 0..1 of a trailer load standing on the pad. */
  load: number
  stagedCartons: number
  dispatched: number
  trailers: number
  cartons: number
  /**
   * Seconds until the dwell timer seals a part-full trailer, or null when the pad
   * is empty. A full load is `0` — it goes on the next step, not on the clock.
   */
  sealIn: number | null
  full: boolean
}

export interface DockInboundWork {
  receiptId: string
  ref: string
  po: string
  supplier: string
  unplanned: boolean
  status: ReceiptStatus
  /**
   * True while the trailer is physically on the door — booked in but not fully
   * counted. Once every line is counted the trailer pulls off and what is left
   * (the putaway) happens on the floor, which is why this is not just `!stored`.
   */
  atDoor: boolean
  lines: number
  linesCounted: number
  linesStored: number
  unitsAdvised: number
  unitsCounted: number
  unitsStored: number
  /** Counted in but not yet on a shelf. */
  unitsToPutAway: number
  /** 0..1 across the whole receipt: counted, then put away. */
  progress: number
  arrivedAt: number
  /** Sim seconds since the trailer hit the door. */
  dwell: number
}

export interface DockActivity {
  id: string
  label: string
  /** Facility order, which is also the sorter's divert index. */
  index: number
  flow: DockFlow
  /** One line naming what the door is doing — the tooltip and board headline. */
  headline: string
  /** 0..1 for whatever {@link headline} describes; drives the bar on the door. */
  progress: number
  outbound: DockOutboundWork
  /** The trailer this door is working, or the last one still to be put away. */
  inbound: DockInboundWork | null
  /** Further trailers booked to this door that have not been worked yet. */
  inboundQueue: number
}

export interface DockActivityInput {
  /** Dock facilities in model order — the authority for which doors exist. */
  docks: { id: string; label: string }[]
  /** Pack-line dock rows, by the same index. Null before the engine has run. */
  metrics: DockMetrics[] | null | undefined
  /** Live parcels, for what is on the belt this instant. */
  parcels: Parcel[]
  receipts: Receipt[]
  /** Sim seconds. */
  time: number
}

/**
 * Which door a trailer is worked on.
 *
 * A yard allocates arrivals across whatever doors are free, so the receipt's own
 * GRN sequence is rotated across the doors: deterministic, evenly spread, and
 * stable for the life of a receipt — a trailer never appears to hop doors
 * between two frames. Returns 0 when the layout has no docks.
 */
export function dockIndexForReceipt(receiptId: string, dockCount: number): number {
  if (dockCount <= 0) return 0
  const digits = receiptId.match(/(\d+)\s*$/)
  const seq = digits ? Number(digits[1]) : 0
  return (Math.max(0, seq - 1) % dockCount + dockCount) % dockCount
}

const EMPTY_OUTBOUND: Omit<DockOutboundWork, 'channels'> = {
  enRoute: 0,
  staged: 0,
  capacity: TRAILER_CAPACITY,
  load: 0,
  stagedCartons: 0,
  dispatched: 0,
  trailers: 0,
  cartons: 0,
  sealIn: null,
  full: false,
}

export function deriveDockActivity(input: DockActivityInput): DockActivity[] {
  const { docks, metrics, parcels, receipts, time } = input
  if (docks.length === 0) return []

  // Belt traffic, counted once rather than per door.
  const enRoute = new Map<number, number>()
  for (const parcel of parcels) {
    if (parcel.stage !== 'conveying') continue
    enRoute.set(parcel.dockIndex, (enRoute.get(parcel.dockIndex) ?? 0) + 1)
  }

  const queues = new Map<number, Receipt[]>()
  for (const receipt of receipts) {
    if (receiptStatus(receipt) === 'stored') continue
    const index = dockIndexForReceipt(receipt.id, docks.length)
    const bucket = queues.get(index)
    if (bucket) bucket.push(receipt)
    else queues.set(index, [receipt])
  }

  return docks.map((dock, index) => {
    const row = metrics?.[index]
    const staged = row?.staged ?? 0
    const outbound: DockOutboundWork = {
      ...EMPTY_OUTBOUND,
      channels: row?.channels ?? [],
      enRoute: enRoute.get(index) ?? 0,
      staged,
      load: Math.min(1, staged / TRAILER_CAPACITY),
      stagedCartons: row?.stagedCartons ?? 0,
      dispatched: row?.dispatched ?? 0,
      trailers: row?.trailers ?? 0,
      cartons: row?.cartons ?? 0,
      full: staged >= TRAILER_CAPACITY,
      sealIn:
        staged > 0
          ? Math.max(0, TRAILER_DWELL - Math.max(0, time - (row?.oldestStagedAt ?? time)))
          : null,
    }
    if (outbound.full) outbound.sealIn = 0

    // Trailers are worked oldest first, so the queue is sorted by arrival and the
    // head of it is the one on the door.
    const queue = (queues.get(index) ?? []).sort((a, b) => a.arrivedAt - b.arrivedAt)
    const working = queue.find((r) => hasArrived(r, time)) ?? null
    const inbound = working ? inboundWorkOf(working, time) : null
    const inboundQueue = Math.max(0, queue.length - (working ? 1 : 0))

    const flow: DockFlow =
      inbound?.atDoor ? 'inbound' : outbound.enRoute > 0 || outbound.staged > 0 ? 'outbound' : 'idle'

    return {
      id: dock.id,
      label: dock.label,
      index,
      flow,
      headline: headlineFor(flow, outbound, inbound),
      progress: flow === 'inbound' && inbound ? inbound.progress : flow === 'outbound' ? outbound.load : 0,
      outbound,
      inbound,
      inboundQueue,
    }
  })
}

/**
 * Has the trailer reached the door?
 *
 * Booked arrival time is the usual answer, but a clerk can count a line in on a
 * paused twin — the physical stock is standing there — so any counting activity
 * counts as arrival regardless of the clock.
 */
function hasArrived(receipt: Receipt, time: number): boolean {
  return receipt.arrivedAt <= time || receiptStatus(receipt) !== 'expected'
}

function inboundWorkOf(receipt: Receipt, time: number): DockInboundWork {
  let unitsAdvised = 0
  let unitsCounted = 0
  let unitsStored = 0
  let linesCounted = 0
  let linesStored = 0
  let unitsToPutAway = 0

  for (const line of receipt.lines) {
    unitsAdvised += line.expectedQty
    unitsStored += line.storedQty
    if (line.status !== 'expected') {
      unitsCounted += line.receivedQty
      linesCounted++
      unitsToPutAway += outstandingUnits(line)
    }
    if (line.status === 'stored') linesStored++
  }

  const status = receiptStatus(receipt)
  // Counting is half the job and putting away is the other half, so a trailer
  // that is fully counted but still on the pallet reads as half done — which is
  // exactly what it is.
  const counted = receipt.lines.length > 0 ? linesCounted / receipt.lines.length : 0
  const stored = receipt.lines.length > 0 ? linesStored / receipt.lines.length : 0

  return {
    receiptId: receipt.id,
    ref: receipt.ref,
    po: receipt.po,
    supplier: receipt.supplier,
    unplanned: receipt.unplanned,
    status,
    atDoor: status === 'expected' || status === 'receiving',
    lines: receipt.lines.length,
    linesCounted,
    linesStored,
    unitsAdvised,
    unitsCounted,
    unitsStored,
    unitsToPutAway,
    progress: Math.min(1, counted * 0.5 + stored * 0.5),
    arrivedAt: receipt.arrivedAt,
    dwell: Math.max(0, time - receipt.arrivedAt),
  }
}

function headlineFor(
  flow: DockFlow,
  outbound: DockOutboundWork,
  inbound: DockInboundWork | null,
): string {
  if (flow === 'inbound' && inbound) {
    if (inbound.linesCounted === 0) return `Trailer ${inbound.ref} on the door — count due`
    return `Unloading ${inbound.ref} · ${inbound.linesCounted}/${inbound.lines} lines counted`
  }
  if (flow === 'outbound') {
    if (outbound.full) return `Trailer full — sealing ${outbound.capacity} parcels`
    if (outbound.staged > 0) {
      return `Loading trailer · ${outbound.staged}/${outbound.capacity} parcels`
    }
    return `${outbound.enRoute} parcel${outbound.enRoute === 1 ? '' : 's'} on the belt`
  }
  if (inbound) return `${inbound.ref} counted — ${inbound.unitsToPutAway} units to put away`
  return 'Idle — no trailer on the door'
}

/**
 * The same derivation, taken straight off application state.
 *
 * The 3D scene and the panels both hold exactly these three things, so routing
 * every caller through one signature is what guarantees the board on the door,
 * the hover card and the dashboard row are the same numbers rather than three
 * separate readings of the same shift.
 */
export function dockActivityOf(
  model: WarehouseModel | null,
  metrics: SimMetrics | null,
  receipts: Receipt[],
): DockActivity[] {
  if (!model) return []
  return deriveDockActivity({
    docks: model.facilities
      .filter((f) => f.kind === 'dock')
      .map((f) => ({ id: f.id, label: f.label })),
    metrics: metrics?.docks,
    parcels: metrics?.parcels ?? [],
    receipts,
    time: metrics?.time ?? 0,
  })
}

/** Short state word for a chip or a 3D board, matching {@link DockFlow}. */
export const DOCK_FLOW_LABEL: Record<DockFlow, string> = {
  inbound: 'Inbound',
  outbound: 'Outbound',
  idle: 'Idle',
}

/**
 * The two lines the board over the door carries: what is being worked, and how
 * far through it the door is.
 *
 * Kept here rather than in the scene so the sign on the door and the card in the
 * inspector are generated from one place and can never disagree.
 */
export function dockBoardLines(state: DockActivity): { primary: string; detail: string } {
  const { outbound, inbound } = state

  if (state.flow === 'inbound' && inbound) {
    return {
      primary: inbound.ref,
      detail:
        inbound.linesCounted === 0
          ? `${inbound.lines} line${inbound.lines === 1 ? '' : 's'} advised · count due`
          : `${inbound.linesCounted}/${inbound.lines} lines · ${inbound.unitsCounted}/${inbound.unitsAdvised} units`,
    }
  }

  if (state.flow === 'outbound') {
    if (outbound.staged === 0) {
      return {
        primary: `${outbound.enRoute} on the belt`,
        detail: 'pad clear · trailer waiting',
      }
    }
    return {
      primary: `${outbound.staged}/${outbound.capacity} loaded`,
      detail: outbound.full
        ? 'full — sealing now'
        : `${outbound.stagedCartons} cartons · seals in ${mmss(outbound.sealIn ?? 0)}`,
    }
  }

  if (inbound) {
    return {
      primary: `${inbound.ref} counted`,
      detail: `${inbound.unitsToPutAway} units to put away`,
    }
  }

  return {
    primary: 'No trailer',
    detail:
      outbound.trailers > 0
        ? `${outbound.trailers} trailer${outbound.trailers === 1 ? '' : 's'} away today`
        : 'door closed',
  }
}

function mmss(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}
