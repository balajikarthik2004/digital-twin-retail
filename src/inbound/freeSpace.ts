import type { Bin, VelocityTier, WarehouseModel } from '../warehouse/types'

/**
 * Free-space accounting.
 *
 * Every figure here is derived from the same two numbers per location —
 * `capacity` and `sku.stock` — so the summary can never disagree with what the
 * putaway ranker sees or with what the inspector shows for a single bin.
 */

/** Units of headroom in a location. */
export function binFree(bin: Bin): number {
  return Math.max(0, bin.capacity - bin.sku.stock)
}

/** 0..1 — how full the location is. */
export function binFill(bin: Bin): number {
  return bin.capacity > 0 ? Math.min(1, bin.sku.stock / bin.capacity) : 1
}

/** An empty location can be re-slotted to any SKU; a part-full one cannot. */
export function isEmpty(bin: Bin): boolean {
  return bin.sku.stock === 0
}

export function needsReplen(bin: Bin): boolean {
  return bin.sku.stock <= bin.sku.replenPoint
}

export interface SpaceBucket {
  key: string
  label: string
  capacity: number
  onHand: number
  free: number
  /** 0..1 */
  occupancy: number
  locations: number
  empty: number
}

export interface FreeSpaceSummary {
  locations: number
  emptyLocations: number
  /** At or above 92% full — effectively unavailable for a putaway. */
  nearFull: number
  replenFlagged: number
  capacityUnits: number
  onHandUnits: number
  freeUnits: number
  /** 0..1 across the whole module. */
  occupancy: number
  byAisle: SpaceBucket[]
  byLevel: SpaceBucket[]
  byVelocity: SpaceBucket[]
}

const NEAR_FULL = 0.92

const VELOCITY_ORDER: VelocityTier[] = ['fast', 'medium', 'slow']
const VELOCITY_SHORT: Record<VelocityTier, string> = { fast: 'A · fast', medium: 'B · medium', slow: 'C · slow' }

/**
 * Roll the whole module up into one occupancy picture, plus the three cuts an
 * operator asks for when deciding where a pallet can go: which aisle, which
 * level, and which velocity zone has room.
 */
export function summariseFreeSpace(model: WarehouseModel): FreeSpaceSummary {
  const aisleBuckets = new Map<number, SpaceBucket>()
  const levelBuckets = new Map<number, SpaceBucket>()
  const velocityBuckets = new Map<VelocityTier, SpaceBucket>()

  const bucket = <K>(map: Map<K, SpaceBucket>, key: K, id: string, label: string): SpaceBucket => {
    let b = map.get(key)
    if (!b) {
      b = { key: id, label, capacity: 0, onHand: 0, free: 0, occupancy: 0, locations: 0, empty: 0 }
      map.set(key, b)
    }
    return b
  }

  let capacityUnits = 0
  let onHandUnits = 0
  let emptyLocations = 0
  let nearFull = 0
  let replenFlagged = 0

  for (const bin of model.bins) {
    const free = binFree(bin)
    const empty = isEmpty(bin)
    capacityUnits += bin.capacity
    onHandUnits += bin.sku.stock
    if (empty) emptyLocations++
    if (binFill(bin) >= NEAR_FULL) nearFull++
    if (needsReplen(bin)) replenFlagged++

    for (const b of [
      bucket(aisleBuckets, bin.aisle, `a${bin.aisle}`, `A${String(bin.aisle + 1).padStart(2, '0')}`),
      bucket(levelBuckets, bin.level, `l${bin.level}`, `Level ${bin.level + 1}`),
      bucket(velocityBuckets, bin.sku.velocity, bin.sku.velocity, VELOCITY_SHORT[bin.sku.velocity]),
    ]) {
      b.capacity += bin.capacity
      b.onHand += bin.sku.stock
      b.free += free
      b.locations++
      if (empty) b.empty++
    }
  }

  const finish = (buckets: SpaceBucket[]) => {
    for (const b of buckets) b.occupancy = b.capacity > 0 ? b.onHand / b.capacity : 0
    return buckets
  }

  return {
    locations: model.bins.length,
    emptyLocations,
    nearFull,
    replenFlagged,
    capacityUnits,
    onHandUnits,
    freeUnits: Math.max(0, capacityUnits - onHandUnits),
    occupancy: capacityUnits > 0 ? onHandUnits / capacityUnits : 0,
    byAisle: finish([...aisleBuckets.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)),
    byLevel: finish([...levelBuckets.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)),
    byVelocity: finish(
      VELOCITY_ORDER.map((t) => velocityBuckets.get(t)).filter((b): b is SpaceBucket => !!b),
    ),
  }
}
