import type { Movement, Receipt } from '../inbound/types'
import type { VelocityTier, WarehouseModel } from '../warehouse/types'

/**
 * Local persistence for everything the operator creates.
 *
 * The warehouse itself is regenerated from its seed on every load, so there is
 * no point saving 2,560 identical locations. What cannot be regenerated is what
 * a person did to it: the products they booked in, the locations those products
 * were placed into, and the log of both. Those are saved as a thin diff and
 * replayed over the freshly generated model.
 *
 * Everything here is best-effort. Storage can be full, disabled or holding a
 * document from an older build — in every case the app must still start, just
 * without the history.
 */

const KEY = 'picktwin.inbound.v1'
const VERSION = 1
/** Keeps the saved document small enough to never bump the ~5 MB quota. */
const MAX_LOG = 250

/** A location whose contents differ from what generation produced. */
export interface BinOverride {
  name: string
  category: string
  velocity: VelocityTier
  unitVolume: number
  capacity: number
  stock: number
  stockInitial: number
  replenPoint: number
}

export interface LayoutSnapshot {
  receipts: Receipt[]
  inboundLog: Movement[]
  binOverrides: Record<string, BinOverride>
  /** Reference counters, so a reload does not re-issue GRN-00001. */
  seq: { receipt: number; line: number }
}

interface PersistDoc {
  version: number
  /** Snapshots are per layout — each building has its own stock and history. */
  layouts: Record<string, LayoutSnapshot>
}

function readDoc(): PersistDoc {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { version: VERSION, layouts: {} }
    const parsed = JSON.parse(raw) as PersistDoc
    if (parsed?.version !== VERSION || typeof parsed.layouts !== 'object') {
      return { version: VERSION, layouts: {} }
    }
    return parsed
  } catch {
    // Corrupt or unreadable — start clean rather than blocking the app.
    return { version: VERSION, layouts: {} }
  }
}

export function loadSnapshot(layoutId: string): LayoutSnapshot | null {
  const doc = readDoc()
  const snapshot = doc.layouts[layoutId]
  if (!snapshot || !Array.isArray(snapshot.receipts)) return null
  return {
    receipts: snapshot.receipts,
    inboundLog: Array.isArray(snapshot.inboundLog) ? snapshot.inboundLog : [],
    binOverrides: snapshot.binOverrides ?? {},
    seq: snapshot.seq ?? { receipt: 1, line: 1 },
  }
}

export function saveSnapshot(layoutId: string, snapshot: LayoutSnapshot): void {
  if (!layoutId) return
  const doc = readDoc()
  doc.layouts[layoutId] = {
    ...snapshot,
    inboundLog: snapshot.inboundLog.slice(-MAX_LOG),
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(doc))
  } catch {
    // Quota exceeded or storage disabled. Losing the save is survivable; losing
    // the putaway the user just confirmed is not, so never rethrow.
  }
}

export function clearSnapshot(layoutId: string): void {
  const doc = readDoc()
  delete doc.layouts[layoutId]
  try {
    localStorage.setItem(KEY, JSON.stringify(doc))
  } catch {
    /* see saveSnapshot */
  }
}

/** Capture a location's current contents, for saving. */
export function overrideFor(model: WarehouseModel, binId: string): BinOverride | null {
  const bin = model.binsById.get(binId)
  if (!bin) return null
  return {
    name: bin.sku.name,
    category: bin.sku.category,
    velocity: bin.sku.velocity,
    unitVolume: bin.sku.unitVolume,
    capacity: bin.capacity,
    stock: bin.sku.stock,
    stockInitial: bin.sku.stockInitial,
    replenPoint: bin.sku.replenPoint,
  }
}

/**
 * Replay saved putaways onto a freshly generated model.
 *
 * Bin ids and SKU ids are both derived deterministically from the layout config
 * and its seed, so a saved override always lands on the same physical location.
 * Anything that no longer resolves (a layout whose config changed) is dropped.
 *
 * @returns how many locations were restored.
 */
export function applyOverrides(
  model: WarehouseModel,
  overrides: Record<string, BinOverride>,
): number {
  let applied = 0
  for (const [binId, o] of Object.entries(overrides)) {
    const bin = model.binsById.get(binId)
    if (!bin || !o) continue
    bin.capacity = Math.max(1, Math.round(o.capacity))
    bin.sku.name = o.name
    bin.sku.category = o.category
    bin.sku.velocity = o.velocity
    bin.sku.unitVolume = o.unitVolume
    bin.sku.replenPoint = o.replenPoint
    bin.sku.stock = Math.min(bin.capacity, Math.max(0, o.stock))
    bin.sku.stockInitial = Math.min(bin.capacity, Math.max(0, o.stockInitial))
    applied++
  }
  return applied
}
