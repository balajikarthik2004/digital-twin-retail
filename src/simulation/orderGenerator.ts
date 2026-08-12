import type { Bin, VelocityTier, WarehouseModel } from '../warehouse/types'
import { isReserveLevel } from '../warehouse/rackGeometry'
import { createRng, type Rng } from '../warehouse/random'
import { slaFor } from './sla'
import type { Order, OrderLine } from './types'

export interface OrderGenOptions {
  count: number
  minLines: number
  maxLines: number
  /** Orders released per minute (Poisson arrivals). */
  arrivalPerMin: number
  /** Simulation time the first order is released at. */
  startAt?: number
  seed?: number
  expressShare?: number
}

const CHANNELS: Order['channel'][] = ['Ecommerce', 'Store Replen', 'Click & Collect', 'Wholesale']

/**
 * Demand is deliberately skewed towards fast movers (60/30/10) — that is what
 * real pick profiles look like, and it is what makes slotting and routing
 * strategy actually matter in the comparison view.
 */
const DEMAND_WEIGHT: Record<VelocityTier, number> = { fast: 0.6, medium: 0.3, slow: 0.1 }

/** Share of lines drawn from the reserve tier rather than the pick face. */
const RESERVE_DEMAND_SHARE = 0.05

let orderSeq = 1

export function resetOrderSequence(): void {
  orderSeq = 1
}

export function generateOrders(model: WarehouseModel, options: OrderGenOptions): Order[] {
  const rng = createRng(options.seed ?? 20260803)
  const pools = buildPools(model)
  const tiers: VelocityTier[] = ['fast', 'medium', 'slow']
  const weights = tiers.map((t) => (pools.pickFace[t].length > 0 ? DEMAND_WEIGHT[t] : 0))

  const orders: Order[] = []
  let t = options.startAt ?? 0
  const ratePerSec = Math.max(options.arrivalPerMin, 0.01) / 60

  for (let i = 0; i < options.count; i++) {
    const lineCount = rng.int(options.minLines, options.maxLines)
    const used = new Set<string>()
    const lines: OrderLine[] = []

    for (let l = 0; l < lineCount; l++) {
      const bin = drawBin(rng, pools, tiers, weights, used)
      if (!bin) break
      used.add(bin.id)
      lines.push({
        sku: bin.sku.id,
        binId: bin.id,
        qty: Math.max(1, Math.min(bin.sku.unitsPerLine, bin.sku.stock)),
      })
    }
    if (lines.length === 0) continue

    const priority = rng.bool(options.expressShare ?? 0.18) ? 'express' : 'standard'
    const releasedAt = Math.max(0, t)
    orders.push({
      id: `ord-${orderSeq}`,
      ref: `SO-${String(100000 + orderSeq).slice(1)}`,
      channel: rng.pick(CHANNELS),
      priority,
      releasedAt,
      dueAt: slaFor({ priority, releasedAt }),
      lines,
    })
    orderSeq++

    // Exponential inter-arrival gives a bursty, realistic release pattern.
    t += -Math.log(1 - rng.next()) / ratePerSec
  }

  return orders
}

function buildPools(model: WarehouseModel): { pickFace: Record<VelocityTier, Bin[]>; reserve: Bin[] } {
  const pools = {
    pickFace: { fast: [], medium: [], slow: [] } as Record<VelocityTier, Bin[]>,
    reserve: [] as Bin[],
  }
  for (const bin of model.bins) {
    if (bin.sku.stock > 0) {
      if (isReserveLevel(model.config, bin.level)) {
        pools.reserve.push(bin)
      } else {
        pools.pickFace[bin.sku.velocity].push(bin)
      }
    }
  }
  return pools
}

function drawBin(
  rng: Rng,
  pools: { pickFace: Record<VelocityTier, Bin[]>; reserve: Bin[] },
  tiers: VelocityTier[],
  weights: number[],
  used: Set<string>,
): Bin | null {
  /*
   * Occasionally send a line to bulk, so the reserve tier is visibly worked.
   *
   * Kept low on purpose. A bulk line is now a genuine journey — cross to the
   * staircase, climb, walk back along the mezzanine, and the same again in
   * reverse — so at 15% it swamped every other dynamic the twin exists to
   * show: walking dominated the shift so completely that an under-staffed
   * pack wall stopped being a bottleneck at all. Real bulk retrieval is
   * occasional, and modelling it that way is both truer and lets the rest of
   * the model breathe.
   */
  if (rng.float(0, 1) < RESERVE_DEMAND_SHARE && pools.reserve.length > 0) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const bin = pools.reserve[rng.int(0, pools.reserve.length - 1)]
      if (!used.has(bin.id)) return bin
    }
  }

  for (let attempt = 0; attempt < 12; attempt++) {
    const tier = rng.weighted(tiers, weights)
    const pool = pools.pickFace[tier]
    if (pool.length === 0) continue
    const bin = pool[rng.int(0, pool.length - 1)]
    if (!used.has(bin.id)) return bin
  }
  // Fall back to a linear scan so tiny warehouses still produce full orders.
  for (const tier of tiers) {
    const found = pools.pickFace[tier].find((b) => !used.has(b.id))
    if (found) return found
  }
  const foundReserve = pools.reserve.find((b) => !used.has(b.id))
  if (foundReserve) return foundReserve

  return null
}

/** Shape accepted by the JSON/textarea importer. Every field except lines is optional. */
export interface OrderImportShape {
  id?: string
  ref?: string
  channel?: string
  priority?: string
  releasedAt?: number
  /** Optional explicit SLA. Defaults to release + 30 min (express) / 120 min. */
  dueAt?: number
  lines: { sku?: string; binId?: string; location?: string; code?: string; qty?: number }[]
}

export interface ImportResult {
  orders: Order[]
  warnings: string[]
}

/**
 * Parse externally supplied orders. Locations may be given as a bin id, an
 * operator location code (`A03-R14-2B`) or a SKU id — whichever the source
 * system happens to emit.
 */
export function importOrders(model: WarehouseModel, raw: unknown): ImportResult {
  const warnings: string[] = []
  const payload = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { orders?: unknown[] }).orders)
      ? (raw as { orders: unknown[] }).orders
      : null

  if (!payload) {
    throw new Error('Expected a JSON array of orders, or an object with an "orders" array.')
  }

  const byCode = new Map(model.bins.map((b) => [b.code.toUpperCase(), b]))
  const bySku = new Map(model.bins.map((b) => [b.sku.id.toUpperCase(), b]))

  const orders: Order[] = []
  payload.forEach((entry, index) => {
    const o = entry as OrderImportShape
    if (!o || !Array.isArray(o.lines)) {
      warnings.push(`Order #${index + 1} skipped: no "lines" array.`)
      return
    }
    const lines: OrderLine[] = []
    for (const line of o.lines) {
      const key = (line.binId ?? line.location ?? line.code ?? line.sku ?? '').toString()
      const bin =
        model.binsById.get(key) ??
        byCode.get(key.toUpperCase()) ??
        bySku.get(key.toUpperCase()) ??
        null
      if (!bin) {
        warnings.push(`Order #${index + 1}: unknown location "${key}" skipped.`)
        continue
      }
      lines.push({ sku: bin.sku.id, binId: bin.id, qty: Math.max(1, Math.round(line.qty ?? 1)) })
    }
    if (lines.length === 0) {
      warnings.push(`Order #${index + 1} skipped: no resolvable lines.`)
      return
    }
    const priority = o.priority === 'express' ? 'express' : 'standard'
    const releasedAt = Math.max(0, o.releasedAt ?? 0)
    orders.push({
      id: o.id ?? `imp-${orderSeq}`,
      ref: o.ref ?? o.id ?? `IMP-${String(orderSeq).padStart(4, '0')}`,
      channel: (CHANNELS.find((c) => c === o.channel) ?? 'Ecommerce') as Order['channel'],
      priority,
      releasedAt,
      // Honour an explicit due time if the source system supplies one.
      dueAt: o.dueAt !== undefined ? o.dueAt : slaFor({ priority, releasedAt }),
      lines,
    })
    orderSeq++
  })

  if (orders.length === 0) throw new Error('No orders could be resolved against this layout.')
  return { orders, warnings }
}
