import { buildRoute } from '../pathfinding/route'
import type { NodeId, RoutingContext, RoutingStrategy } from '../pathfinding/types'
import type { WarehouseModel } from '../warehouse/types'
import { describeRoute, estimatePutawaySec } from './directions'
import { binFree } from './freeSpace'
import { rankLocations } from './putaway'
import { outstandingUnits, type PutawayPlan, type Receipt, type ReceiptLine } from './types'

/**
 * One destination, so there is no ordering decision to make — but the walk is
 * still built by the same `buildRoute` the pickers use, on the same graph, so a
 * putaway route and a pick route are measured in exactly the same metres.
 */
const DIRECT: RoutingStrategy = {
  id: 'direct',
  name: 'Direct',
  blurb: 'Shortest walk from goods-in to the location.',
  sequence: (_ctx, stops) => stops,
}

export interface PlanOptions {
  /** Force a specific location instead of the top-ranked one. */
  chosenBinId?: string
  /** Walking pace for the time estimate, m/s. */
  speed?: number
  /** Node the walk starts from. Defaults to the goods-in lane. */
  from?: NodeId
  /** How many alternatives the plan carries. */
  shortlist?: number
}

/** Alternatives shown beside the recommendation, and tinted in the 3D scene. */
const SHORTLIST = 6

/**
 * Rank the free space for a receipt line and draw the walk to the winner.
 *
 * The ranking always covers EVERY legal location, not a shortlist. The manual
 * picker lets an operator choose any of the several hundred free locations, and
 * a plan that could not find the one they picked used to fall back to the
 * recommendation — silently drawing the route to a different shelf.
 *
 * Returns `null` when the delivery has nowhere legal to go, or when a named
 * location is not one of the places this line may be put.
 */
export function planPutaway(
  model: WarehouseModel,
  ctx: RoutingContext,
  receipt: Receipt,
  line: ReceiptLine,
  options: PlanOptions = {},
): PutawayPlan | null {
  // Nothing may be put away before it has been counted in — until then the
  // quantity is the supplier's claim, and there is no work to plan.
  const outstanding = outstandingUnits(line)
  if (line.status === 'expected' || outstanding === 0) return null

  const ranked = rankLocations(
    model,
    ctx,
    {
      skuId: line.skuId,
      velocity: line.velocity,
      qty: outstanding,
      unitVolume: line.unitVolume,
    },
    { limit: Infinity, all: true, from: options.from },
  )
  if (ranked.length === 0) return null

  const chosen = options.chosenBinId
    ? ranked.find((c) => c.binId === options.chosenBinId)
    : ranked[0]
  // A named location that is not legal is an error to report, never something
  // to quietly substitute.
  if (!chosen) return null

  const size = Math.max(1, options.shortlist ?? SHORTLIST)
  const top = ranked.slice(0, size)
  // The chosen location is always on the plan — the scene highlights `candidates`
  // and the panel looks the selection up in it.
  const candidates = top.some((c) => c.binId === chosen.binId)
    ? top
    : [chosen, ...top.slice(0, size - 1)]

  const route = buildRoute(
    ctx,
    DIRECT,
    [{ node: chosen.bin.node, ref: chosen.binId, serviceTime: 0 }],
    options.from ?? model.receiving,
    chosen.bin.node,
  )

  return {
    receiptId: receipt.id,
    lineId: line.id,
    candidates,
    chosenBinId: chosen.binId,
    route,
    directions: describeRoute(model, route, chosen.bin),
    estimateSec: estimatePutawaySec(route.distance, chosen.fits, {
      speed: options.speed ?? model.config.pickerSpeed,
    }),
  }
}

export interface PutawayResult {
  binId: string
  code: string
  /** Units that actually went on the shelf. */
  qty: number
  /** Units still on the pallet afterwards. */
  remaining: number
  distance: number
}

/**
 * Put the stock away for real.
 *
 * `stockInitial` moves with `stock` on purpose: a reset restores the *shift*, not
 * the warehouse, and goods that were physically received should still be on the
 * shelf afterwards.
 */
export function applyPutaway(
  model: WarehouseModel,
  line: ReceiptLine,
  binId: string,
  at: number,
  distance = 0,
): PutawayResult | null {
  const bin = model.binsById.get(binId)
  if (!bin) return null
  // Uncounted stock cannot be put away — see `planPutaway`.
  if (line.status === 'expected') return null

  const outstanding = outstandingUnits(line)
  if (outstanding === 0) return null

  const sameSku = bin.sku.id === line.skuId
  if (!sameSku && bin.sku.stock > 0) return null

  if (!sameSku) {
    // Re-slotting an empty location: the shelf now belongs to the new line, and
    // its capacity is re-sized for how big the new units actually are.
    bin.capacity = Math.max(1, Math.round((bin.capacity * bin.sku.unitVolume) / line.unitVolume))
    bin.sku.name = line.name
    bin.sku.category = line.category
    bin.sku.velocity = line.velocity
    bin.sku.unitVolume = line.unitVolume
    bin.sku.replenPoint = Math.max(2, Math.round(bin.capacity * 0.12))
    line.skuId = bin.sku.id
  }

  const qty = Math.min(outstanding, binFree(bin))
  if (qty <= 0) return null

  bin.sku.stock += qty
  bin.sku.stockInitial += qty

  line.storedQty += qty
  line.storedBinId = binId
  line.storedCode = bin.code
  line.storedAt = at
  line.status = line.storedQty >= line.receivedQty ? 'stored' : 'received'

  return {
    binId,
    code: bin.code,
    qty,
    remaining: outstandingUnits(line),
    distance,
  }
}
