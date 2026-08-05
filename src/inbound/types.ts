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

export type ReceiptLineStatus = 'pending' | 'stored'

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
  /** Units on the pallet. */
  qty: number
  /** Litres per unit — decides how much of a location the delivery consumes. */
  unitVolume: number
  status: ReceiptLineStatus
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
  supplier: string
  /** Sim seconds the trailer hit the goods-in door. */
  arrivedAt: number
  lines: ReceiptLine[]
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
