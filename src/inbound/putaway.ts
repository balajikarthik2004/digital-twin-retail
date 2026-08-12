import type { NodeId, RoutingContext } from '../pathfinding/types'
import type { Bin, VelocityTier, WarehouseModel } from '../warehouse/types'
import { isReserveLevel } from '../warehouse/rackGeometry'
import { binFree, isEmpty, needsReplen } from './freeSpace'
import type { PutawayCandidate, PutawayFit } from './types'

/**
 * Where does this pallet go?
 *
 * The answer is a trade-off, not a lookup, so it is scored rather than filtered.
 * The weights below are the priorities a slotting policy actually encodes:
 * keep a SKU in one place, don't split a delivery, don't walk further than you
 * have to, and respect the ABC zoning the racking was laid out for.
 */

export interface PutawayRequest {
  /** Catalogue SKU being received, or `null` for a line new to the facility. */
  skuId: string | null
  velocity: VelocityTier
  qty: number
  /** Litres per unit — an empty location holds fewer big units than small ones. */
  unitVolume: number
}

export interface RankOptions {
  /** How many suggestions to return. */
  limit?: number
  /** Node the putaway walk starts from. Defaults to the goods-in lane. */
  from?: NodeId
  /**
   * Score every legal location instead of pre-trimming to the nearest few
   * hundred. Used by the manual picker, which has to list all the free space.
   */
  all?: boolean
}

const WEIGHTS = {
  /** Consolidating into the SKU's own home location beats opening a new one. */
  fit: 0.24,
  /** Landing the whole delivery in one location, rather than splitting it. */
  capacity: 0.2,
  /** Walking metres from goods-in. */
  travel: 0.22,
  /** ABC discipline — a fast line belongs in a fast-line location. */
  zone: 0.16,
  /** Golden-zone shelf height: no stooping, no ladder. */
  ergonomics: 0.1,
  /** A location already below its replen point wants this stock most. */
  urgency: 0.08,
}

const TIER_RANK: Record<VelocityTier, number> = { fast: 0, medium: 1, slow: 2 }

/** How much of the shortlist to consider before trimming to `limit`. */
const CONSIDERED = 400

/**
 * Rank the legal locations for a delivery, best first.
 *
 * A location is legal only if it already holds this SKU (a top-up) or is
 * completely empty (a re-slot). Mixing two SKUs into one pick face is not a
 * trade-off — it is a picking error waiting to happen — so it is filtered out
 * rather than scored down.
 */
export function rankLocations(
  model: WarehouseModel,
  ctx: RoutingContext,
  request: PutawayRequest,
  options: RankOptions = {},
): PutawayCandidate[] {
  const limit = options.limit ?? 6
  const from = options.from ?? model.receiving
  const qty = Math.max(1, Math.round(request.qty))

  // Golden level: shoulder height where reachable, ground floor otherwise.
  const goldenLevel = Math.min(model.config.levels - 1, 1)
  const topLevel = model.config.levels - 1

  interface Scratch {
    bin: Bin
    fit: PutawayFit
    free: number
    fits: number
    distance: number
  }

  const scratch: Scratch[] = []
  for (const bin of model.bins) {
    /*
     * Case putaway is a pick-face job. Bulk positions are filled by pallet,
     * off a truck, up the reserve tier — a different flow with different kit,
     * and one this panel does not model.
     *
     * Excluding them is also what keeps the ranking honest: a bulk location's
     * walking distance now includes the trip to a staircase and the climb, so
     * leaving them in the candidate set put a 90 m outlier alongside 15 m
     * shelf positions and flattened the distance term that is supposed to
     * separate the near shelves from the far ones.
     */
    if (isReserveLevel(model.config, bin.level)) continue
    const topUp = request.skuId !== null && bin.sku.id === request.skuId
    const empty = isEmpty(bin)
    if (!topUp && !empty) continue

    // An empty location's capacity was sized for its resident SKU. Capacity is
    // inversely proportional to unit volume, so re-scale it for what is arriving.
    const free = topUp
      ? binFree(bin)
      : Math.max(1, Math.round((bin.capacity * bin.sku.unitVolume) / request.unitVolume))
    if (free <= 0) continue

    const distance = ctx.distance(from, bin.node)
    if (!Number.isFinite(distance)) continue

    scratch.push({ bin, fit: topUp ? 'topUp' : 'empty', free, fits: Math.min(qty, free), distance })
  }

  if (scratch.length === 0) return []

  // Cheap pre-trim: among empty locations the winner is almost always near the
  // door, and scoring the whole facility to throw away 99% of it is wasted work
  // on a big layout. Top-ups are never trimmed — the SKU's own home location has
  // to be on the shortlist however far away it is.
  const topUps = scratch.filter((s) => s.fit === 'topUp')
  const empties = scratch.filter((s) => s.fit === 'empty').sort((a, b) => a.distance - b.distance)
  const pool = options.all ? [...topUps, ...empties] : [...topUps, ...empties.slice(0, CONSIDERED)]

  const maxDistance = Math.max(...pool.map((s) => s.distance), 1)

  const scored = pool.map((s) => {
    const bin = s.bin
    const fitScore = s.fit === 'topUp' ? 1 : 0.8
    const capacityScore = s.fits / qty
    const travelScore = 1 - s.distance / maxDistance

    const tierGap = Math.abs(TIER_RANK[bin.sku.velocity] - TIER_RANK[request.velocity])
    const zoneScore = tierGap === 0 ? 1 : tierGap === 1 ? 0.5 : 0.15

    const levelGap = Math.abs(bin.level - goldenLevel)
    const ergonomicsScore = Math.max(0.25, 1 - levelGap * 0.28)

    const urgencyScore = s.fit === 'topUp' && needsReplen(bin) ? 1 : 0

    const score =
      WEIGHTS.fit * fitScore +
      WEIGHTS.capacity * capacityScore +
      WEIGHTS.travel * travelScore +
      WEIGHTS.zone * zoneScore +
      WEIGHTS.ergonomics * ergonomicsScore +
      WEIGHTS.urgency * urgencyScore

    const reasons: string[] = []
    if (s.fit === 'topUp') {
      reasons.push(
        needsReplen(bin)
          ? `Home location for this SKU and below its replen point (${bin.sku.stock} of ${bin.capacity})`
          : `Home location for this SKU — keeps it in one pick face`,
      )
    } else {
      reasons.push(`Empty location — free to re-slot, holds about ${s.free} units of this line`)
    }
    if (capacityScore >= 1) reasons.push(`Takes the whole delivery (${qty} units) in one drop`)
    if (travelScore > 0.75) reasons.push(`Close to goods-in — ${Math.round(s.distance)} m walk`)
    if (tierGap === 0) {
      reasons.push(`Sits in the ${ZONE_LABEL[request.velocity]} zone, matching the line's velocity`)
    }
    if (levelGap === 0) reasons.push('Golden-zone shelf height — no ladder, no stooping')

    const warnings: string[] = []
    if (s.fits < qty) {
      warnings.push(`Only ${s.fits} of ${qty} units fit — plan a second location for the remainder`)
    }
    if (bin.level === topLevel && topLevel > 1) {
      warnings.push(`Top level (L${bin.level + 1}) — needs an order picker to reach`)
    }
    if (tierGap === 2) {
      warnings.push(
        `${ZONE_LABEL[bin.sku.velocity]} location for a ${ZONE_LABEL[request.velocity]} line — it will cost pick time later`,
      )
    }

    return {
      bin,
      binId: bin.id,
      code: bin.code,
      fit: s.fit,
      free: s.free,
      fits: s.fits,
      distance: s.distance,
      score: Math.round(score * 100),
      reasons,
      warnings,
    } satisfies PutawayCandidate
  })

  scored.sort((a, b) => b.score - a.score || a.distance - b.distance)
  return Number.isFinite(limit) ? scored.slice(0, limit) : scored
}

/**
 * Every location this delivery could legally go into, best first.
 *
 * The auto-suggestion is this list's head; the manual picker is the whole list.
 * Both come from one ranking pass so the scores an operator browses are the
 * same numbers the recommendation was made on.
 */
export function listAvailable(
  model: WarehouseModel,
  ctx: RoutingContext,
  request: PutawayRequest,
  from?: NodeId,
): PutawayCandidate[] {
  return rankLocations(model, ctx, request, { limit: Infinity, all: true, from })
}

const ZONE_LABEL: Record<VelocityTier, string> = {
  fast: 'A / fast-mover',
  medium: 'B / medium-mover',
  slow: 'C / slow-mover',
}
