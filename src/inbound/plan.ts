import { buildRoute } from '../pathfinding/route'
import type { RoutingContext, RoutingStrategy } from '../pathfinding/types'
import type { WarehouseModel } from '../warehouse/types'
import { describeRoute, estimatePutawaySec } from './directions'
import { binFree } from './freeSpace'
import { rankLocations, type RankOptions } from './putaway'
import type { PutawayPlan, Receipt, ReceiptLine } from './types'

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

export interface PlanOptions extends RankOptions {
  /** Force a specific location instead of the top-ranked one. */
  chosenBinId?: string
  /** Walking pace for the time estimate, m/s. */
  speed?: number
}

/**
 * Rank the free space for a receipt line and draw the walk to the winner.
 *
 * Returns `null` only when the delivery genuinely has nowhere legal to go — a
 * full facility, or a new line with no empty locations left.
 */
export function planPutaway(
  model: WarehouseModel,
  ctx: RoutingContext,
  receipt: Receipt,
  line: ReceiptLine,
  options: PlanOptions = {},
): PutawayPlan | null {
  const candidates = rankLocations(
    model,
    ctx,
    {
      skuId: line.skuId,
      velocity: line.velocity,
      qty: line.qty - line.storedQty,
      unitVolume: line.unitVolume,
    },
    options,
  )
  if (candidates.length === 0) return null

  const chosen =
    candidates.find((c) => c.binId === options.chosenBinId) ?? candidates[0]

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

  const outstanding = Math.max(0, line.qty - line.storedQty)
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
  line.status = line.storedQty >= line.qty ? 'stored' : 'pending'

  return {
    binId,
    code: bin.code,
    qty,
    remaining: Math.max(0, line.qty - line.storedQty),
    distance,
  }
}
