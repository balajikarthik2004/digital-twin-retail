import type { Route } from '../pathfinding/types'
import type { Bin, VelocityTier } from '../warehouse/types'

/**
 * Inbound (goods-in) domain types.
 *
 * The flow this models is the one a receiving clerk actually walks:
 *
 *   trailer arrives  →  a line is booked in  →  where do I put it?
 *        →  the system ranks free locations  →  it draws the walk
 *        →  the clerk confirms  →  stock is on the shelf, and it is history.
 *
 * Nothing here knows about React or Three.js: the ranking and the directions are
 * pure functions over the warehouse model and the nav graph.
 */

/**
 * A delivery line's lifecycle, which is the receiving process itself:
 *
 *   expected  the advice note says it is coming; nothing has been counted
 *   received  counted in at the door — this is the goods receipt
 *   stored    put away into a location
 *
 * Nothing may be put away before it has been received, because until someone
 * counts it the quantity is a supplier's claim rather than a fact.
 */
export type ReceiptLineStatus = 'expected' | 'received' | 'stored'

export interface ReceiptLine {
  id: string
  /**
   * Catalogue SKU this delivery tops up. `null` means a line the facility has
   * never held before, which can only go to an empty location.
   */
  skuId: string | null
  name: string
  category: string
  velocity: VelocityTier
  /** Units the advice note says are coming. */
  expectedQty: number
  /** Units actually counted in at the door. 0 until the line is received. */
  receivedQty: number
  /** Litres per unit — decides how much of a location the delivery consumes. */
  unitVolume: number
  status: ReceiptLineStatus
  /** Sim seconds the count was accepted. */
  receivedAt: number | null
  /** Location the units went to, once put away. */
  storedBinId: string | null
  storedCode: string | null
  /** Sim seconds at putaway confirmation. */
  storedAt: number | null
  /** Units actually put away (a delivery can exceed a single location). */
  storedQty: number
}

export interface Receipt {
  id: string
  /** Goods-received note reference. */
  ref: string
  /** Purchase order the delivery is against. */
  po: string
  supplier: string
  /** Sim seconds the trailer hit the goods-in door. */
  arrivedAt: number
  /**
   * True for stock that turned up without an advice note. It skips the expected
   * state — you are holding it, so it is received by definition.
   */
  unplanned: boolean
  lines: ReceiptLine[]
}

/** Where a delivery has got to, rolled up from its lines. */
export type ReceiptStatus = 'expected' | 'receiving' | 'received' | 'stored'

export function receiptStatus(receipt: Receipt): ReceiptStatus {
  const lines = receipt.lines
  if (lines.every((l) => l.status === 'stored')) return 'stored'
  if (lines.every((l) => l.status === 'expected')) return 'expected'
  if (lines.some((l) => l.status === 'expected')) return 'receiving'
  return 'received'
}

/** Units still to put away on a line. */
export function outstandingUnits(line: ReceiptLine): number {
  return Math.max(0, line.receivedQty - line.storedQty)
}

/** Counted short or over against the advice note. Negative is short. */
export function variance(line: ReceiptLine): number {
  return line.status === 'expected' ? 0 : line.receivedQty - line.expectedQty
}

/** Why a location is legal for this delivery. Mixed-SKU locations are not. */
export type PutawayFit = 'topUp' | 'empty'

export interface PutawayCandidate {
  bin: Bin
  binId: string
  code: string
  fit: PutawayFit
  /** Units of headroom the location has right now. */
  free: number
  /** Units of THIS delivery that fit — less than the delivery when it overflows. */
  fits: number
  /** Walking metres from goods-in to the location's pick face. */
  distance: number
  /** 0..100, higher is better. */
  score: number
  /** Plain-language justification, best factor first. */
  reasons: string[]
  /** Anything the clerk should know before accepting the suggestion. */
  warnings: string[]
}

/** One leg of the walk from goods-in to the shelf. */
export interface RouteStep {
  index: number
  text: string
  /** Metres covered by this leg; 0 for the arrival instruction. */
  metres: number
}

/**
 * A putaway that has been planned but not yet confirmed. Held in the store so
 * the 3D scene, the panel and the inspector all read the same decision.
 */
export interface PutawayPlan {
  receiptId: string
  lineId: string
  /** Ranked shortlist. `chosenBinId` always points at one of these. */
  candidates: PutawayCandidate[]
  chosenBinId: string
  /** Goods-in → chosen location, on the same nav graph the pickers walk. */
  route: Route
  directions: RouteStep[]
  /** Seconds to walk it at the current picker pace, plus a handling allowance. */
  estimateSec: number
}

/** The outcome of a confirmed putaway — what actually landed on the shelf. */
export interface Placement {
  binId: string
  code: string
  name: string
  /** Units that went on the shelf. */
  qty: number
  /** Units still on the pallet, when one location could not take it all. */
  remaining: number
  distance: number
  at: number
}

export type MovementKind = 'inbound' | 'outbound'

/** One line in the unified history log. */
export interface Movement {
  id: string
  kind: MovementKind
  /** Sim seconds. */
  at: number
  ref: string
  /** SKU or order description. */
  detail: string
  /** Location code (inbound) or dock label (outbound). */
  location: string
  qty: number
  /** Metres walked — planned for inbound, actual for outbound. */
  distance: number
  /** Outbound only: whether it beat its SLA. */
  onTime: boolean | null
}
