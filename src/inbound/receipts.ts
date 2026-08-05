import { makeCatalogEntry } from '../warehouse/catalog'
import { createRng, type Rng } from '../warehouse/random'
import type { Bin, VelocityTier, WarehouseModel } from '../warehouse/types'
import { binFill, binFree, needsReplen } from './freeSpace'
import type { Receipt, ReceiptLine } from './types'

/**
 * Inbound demand.
 *
 * Deliveries are not random: a real goods-in queue is mostly replenishment of
 * lines that have run down, with the occasional new line the buyers have taken
 * on. Generating that mix is what makes the putaway suggestions interesting —
 * top-ups compete with empty locations for the same shelf space.
 */

const SUPPLIERS = [
  'Nordvale Foods',
  'Harborline Distribution',
  'Cedarleaf Brands',
  'Brightmoor Supply Co.',
  'Kestrel Logistics',
  'Aurora Trading',
  'Tallgrass Wholesale',
  'Ironwood Imports',
]

let receiptSeq = 1
let lineSeq = 1

export function resetReceiptSequence(): void {
  receiptSeq = 1
  lineSeq = 1
}

/** Current counters, for persisting across a reload. */
export function receiptSequence(): { receipt: number; line: number } {
  return { receipt: receiptSeq, line: lineSeq }
}

/** Resume the counters so restored references are never re-issued. */
export function restoreReceiptSequence(seq: { receipt: number; line: number }): void {
  receiptSeq = Math.max(1, Math.floor(seq.receipt) || 1)
  lineSeq = Math.max(1, Math.floor(seq.line) || 1)
}

export interface ReceiptGenOptions {
  /** Trailers to book in. */
  count: number
  seed?: number
  /** Sim seconds the first trailer arrives. */
  startAt?: number
  /** Minutes between arrivals. */
  minutesApart?: number
  /** Share of lines that are new to the facility (empty location required). */
  newLineShare?: number
}

/** Units per pallet, by tier — fast movers arrive in far bigger drops. */
const DROP_SIZE: Record<VelocityTier, [number, number]> = {
  fast: [80, 420],
  medium: [40, 180],
  slow: [10, 60],
}

export function generateReceipts(model: WarehouseModel, options: ReceiptGenOptions): Receipt[] {
  const rng = createRng(options.seed ?? 90210)
  const newLineShare = options.newLineShare ?? 0.28
  const gapSec = Math.max(1, options.minutesApart ?? 22) * 60

  // Lines worth replenishing, most-depleted first, so the generated queue looks
  // like a real goods-in board rather than a random sample of the catalogue.
  const depleted = model.bins
    .filter((b) => b.sku.stock > 0 && binFree(b) > 20)
    .sort((a, b) => (needsReplen(b) ? 1 : 0) - (needsReplen(a) ? 1 : 0) || binFill(a) - binFill(b))
    .slice(0, 300)

  let cursor = 0
  const receipts: Receipt[] = []
  let at = options.startAt ?? 0

  for (let i = 0; i < options.count; i++) {
    const lineCount = rng.int(1, 4)
    const lines: ReceiptLine[] = []

    for (let l = 0; l < lineCount; l++) {
      if (rng.bool(newLineShare)) {
        lines.push(newLine(rng))
      } else {
        const bin = depleted[cursor++ % Math.max(1, depleted.length)]
        if (bin) lines.push(topUpLine(rng, bin))
        else lines.push(newLine(rng))
      }
    }

    receipts.push({
      id: `grn-${receiptSeq}`,
      ref: `GRN-${String(100000 + receiptSeq).slice(1)}`,
      po: `PO-${String(400000 + receiptSeq * 7).slice(1)}`,
      supplier: rng.pick(SUPPLIERS),
      arrivedAt: Math.max(0, at),
      unplanned: false,
      lines,
    })
    receiptSeq++
    at += gapSec * rng.float(0.4, 1.6)
  }

  return receipts
}

/** A line on the advice note — expected, not yet counted. */
function expectedLine(
  fields: Pick<ReceiptLine, 'skuId' | 'name' | 'category' | 'velocity' | 'unitVolume'>,
  expectedQty: number,
): ReceiptLine {
  return {
    id: `rl-${lineSeq++}`,
    ...fields,
    expectedQty,
    receivedQty: 0,
    status: 'expected',
    receivedAt: null,
    storedBinId: null,
    storedCode: null,
    storedAt: null,
    storedQty: 0,
  }
}

/** A replenishment of a line the facility already holds. */
function topUpLine(rng: Rng, bin: Bin): ReceiptLine {
  const [min, max] = DROP_SIZE[bin.sku.velocity]
  // Never advise more than the home location could ever take — a delivery that
  // cannot land anywhere is a data-entry bug, not an interesting decision.
  const qty = Math.max(1, Math.min(binFree(bin), rng.int(min, max)))
  return expectedLine(
    {
      skuId: bin.sku.id,
      name: bin.sku.name,
      category: bin.sku.category,
      velocity: bin.sku.velocity,
      unitVolume: bin.sku.unitVolume,
    },
    qty,
  )
}

/** A line new to the facility — it has no home location yet. */
function newLine(rng: Rng): ReceiptLine {
  const { name, category } = makeCatalogEntry(rng)
  const velocity: VelocityTier = rng.weighted(['fast', 'medium', 'slow'] as const, [0.25, 0.4, 0.35])
  const [min, max] = DROP_SIZE[velocity]
  return expectedLine(
    {
      skuId: null,
      name,
      category,
      velocity,
      unitVolume: Math.round(rng.float(0.5, 9) * 10) / 10,
    },
    rng.int(min, max),
  )
}

export interface ManualReceiptInput {
  name: string
  /** Existing catalogue SKU, or null to book the line in as new. */
  skuId: string | null
  category: string
  velocity: VelocityTier
  qty: number
  unitVolume: number
  supplier?: string
  at?: number
}

/**
 * An unplanned receipt — stock at the door with no advice note against it.
 *
 * It skips the expected state: the operator is standing there holding it and has
 * just typed the count, so it is received the moment it is booked in.
 */
export function createManualReceipt(input: ManualReceiptInput): Receipt {
  const qty = Math.max(1, Math.round(input.qty))
  const at = Math.max(0, input.at ?? 0)
  const line: ReceiptLine = {
    id: `rl-${lineSeq++}`,
    skuId: input.skuId,
    name: input.name,
    category: input.category,
    velocity: input.velocity,
    expectedQty: qty,
    receivedQty: qty,
    unitVolume: Math.max(0.1, input.unitVolume),
    status: 'received',
    receivedAt: at,
    storedBinId: null,
    storedCode: null,
    storedAt: null,
    storedQty: 0,
  }
  const receipt: Receipt = {
    id: `grn-${receiptSeq}`,
    ref: `GRN-${String(100000 + receiptSeq).slice(1)}`,
    po: 'no advice note',
    supplier: input.supplier?.trim() || 'Unplanned — booked in at the door',
    arrivedAt: at,
    unplanned: true,
    lines: [line],
  }
  receiptSeq++
  return receipt
}

/**
 * Accept a count against an advice-note line. This is the goods receipt: before
 * it the quantity is the supplier's claim, after it it is the facility's.
 */
export function receiveLine(line: ReceiptLine, countedQty: number, at: number): void {
  line.receivedQty = Math.max(0, Math.round(countedQty))
  line.receivedAt = at
  line.status = 'received'
}
