import { NavGraphBuilder } from '../pathfinding/graph'
import type { NodeId } from '../pathfinding/types'
import { makeCatalogEntry, type CatalogEntry } from './catalog'
import { buildConveyorNetwork } from './conveyor'
import { RESERVE_LEVELS, levelFaceY } from './rackGeometry'
import { createRng } from './random'
import type {
  Bin,
  Facility,
  RackRun,
  Sku,
  VelocityTier,
  WarehouseConfig,
  WarehouseModel,
} from './types'

const X_TOLERANCE = 0.01

/** Share of storage locations assigned to each velocity tier (ABC slotting). */
const TIER_SPLIT: Record<VelocityTier, number> = { fast: 0.2, medium: 0.3, slow: 0.5 }

/**
 * Fraction of a slot's clear volume that is actually usable once cases are
 * stacked with real-world gaps and overhang. Nobody fills a location to 100%.
 */
const PACKING_EFFICIENCY = 0.62

/** Litres per unit, by tier — fast movers are typically the smaller lines. */
const UNIT_VOLUME: Record<VelocityTier, [number, number]> = {
  fast: [0.4, 3.5],
  medium: [0.8, 6],
  slow: [1.5, 14],
}

/** Opening on-hand as a share of capacity, so free space is a real number. */
const OPENING_FILL: Record<VelocityTier, [number, number]> = {
  fast: [0.45, 0.92],
  medium: [0.3, 0.85],
  slow: [0.08, 0.7],
}

/** Below this share of capacity the location is flagged for replenishment. */
const REPLEN_SHARE: Record<VelocityTier, number> = { fast: 0.2, medium: 0.14, slow: 0.08 }

/**
 * Share of locations left genuinely empty. Real facilities run with slack — and
 * without it there would be nowhere to put an inbound delivery of a new line.
 */
const EMPTY_SHARE = 0.11

/*
 * ── Reserve tier slotting ────────────────────────────────────────────────────
 *
 * The tier above the pick face is bulk storage, and it is slotted the way a
 * real one is: long-tail lines that don't turn over fast enough to earn a
 * pick-face slot. So it skews hard to slow movers, holds far more per location
 * (pallets, not cases), and is picked from far less often — which is exactly
 * what makes a reserve pick worth showing when it does happen.
 *
 * Reserve locations carry their OWN SKUs rather than overstock of the pick
 * face's. That keeps `binBySku` a genuine one-bin-per-SKU map — the invariant
 * order import and demand generation both rely on — and it is the honest model
 * for long-tail stock that only ever lives in bulk.
 */
const RESERVE_TIER_SPLIT: Record<VelocityTier, number> = { fast: 0, medium: 0.25, slow: 0.75 }

/** A reserve location is a pallet position: several times a case-pick slot. */
const RESERVE_CAPACITY_FACTOR = 3.4

/** Reserve runs fuller than the pick face — it is what the pick face draws down from. */
const RESERVE_OPENING_FILL: [number, number] = [0.55, 0.98]

/** Bulk sits on a pallet position that is either loaded or not; far less slack than the pick face. */
const RESERVE_EMPTY_SHARE = 0.05

/**
 * Share of real catalogue products slotted into bulk rather than the pick
 * face, so an imported wave actually sends pickers up the rack. High enough to
 * be visible in a 60-order demo wave, low enough that the pick face stays
 * where the overwhelming majority of the work is.
 */
const REAL_ON_RESERVE_SHARE = 0.22

/**
 * Build the entire warehouse — geometry descriptors, storage locations, SKU
 * catalogue and navigation graph — from a declarative config.
 *
 * Layout, in metres, with x across aisles and z front-to-back:
 *
 *   z ↑   ┌──────────────── back cross aisle ──────────────┐
 *         │ ▓▓ │ aisle │ ▓▓▓▓ │ aisle │ ▓▓▓▓ │ aisle │ ▓▓ │   block 1
 *         ├──────────────── mid cross aisle ───────────────┤
 *         │ ▓▓ │ aisle │ ▓▓▓▓ │ aisle │ ▓▓▓▓ │ aisle │ ▓▓ │   block 0
 *         ├──────────────── front cross aisle ─────────────┤
 *         │            pack stations  ·  staging           │   apron
 *         └──────────── dock doors (front wall) ───────────┘
 *                                                            → x
 *
 * @param realCatalog  Real product identity to seed into the catalogue, e.g.
 * from an imported spreadsheet. Consumed round-robin across every aisle (see
 * where it is used below) until exhausted; every remaining bin gets a
 * synthetic entry exactly as it always did. Omit for a fully synthetic
 * warehouse.
 */
export function generateWarehouse(
  config: WarehouseConfig,
  realCatalog: CatalogEntry[] = [],
): WarehouseModel {
  const rng = createRng(config.seed)
  const {
    aisles,
    aisleWidth,
    rackDepth,
    bayWidth,
    baysPerBlock,
    blocks,
    levels,
    levelHeight,
    slotsPerBay,
    crossAisleWidth,
    apronDepth,
  } = config

  // ── X axis: aisle centrelines, centred on the origin ──────────────────────
  const pitch = aisleWidth + 2 * rackDepth
  const totalWidth = aisles * pitch
  const offsetX = -totalWidth / 2
  const aisleX = Array.from({ length: aisles }, (_, a) => offsetX + rackDepth + aisleWidth / 2 + a * pitch)

  // ── Z axis: blocks separated by cross aisles, centred on the origin ───────
  const blockLength = baysPerBlock * bayWidth
  const totalDepth = blocks * blockLength + (blocks + 1) * crossAisleWidth
  const offsetZ = -totalDepth / 2
  const crossZ = Array.from(
    { length: blocks + 1 },
    (_, c) => offsetZ + crossAisleWidth / 2 + c * (blockLength + crossAisleWidth),
  )
  const blockStartZ = (b: number) => crossZ[b] + crossAisleWidth / 2

  const storageMinZ = offsetZ
  const apronLaneZ = storageMinZ - apronDepth * 0.5
  const dockZ = storageMinZ - apronDepth * 0.88
  const packZ = storageMinZ - apronDepth * 0.18
  const stagingZ = storageMinZ - apronDepth * 0.7

  const g = new NavGraphBuilder()

  // ── Aisle bay nodes ───────────────────────────────────────────────────────
  const aisleNodeId = (a: number, b: number, k: number): NodeId => `n:a${a}:b${b}:y${k}`
  const bayCenterZ = (b: number, k: number) => blockStartZ(b) + (k + 0.5) * bayWidth

  for (let a = 0; a < aisles; a++) {
    for (let b = 0; b < blocks; b++) {
      for (let k = 0; k < baysPerBlock; k++) {
        g.addNode({
          id: aisleNodeId(a, b, k),
          pos: { x: aisleX[a], y: bayCenterZ(b, k) },
          kind: 'aisle',
          aisle: a,
          rank: b * baysPerBlock + k,
        })
      }
      for (let k = 1; k < baysPerBlock; k++) {
        g.link(aisleNodeId(a, b, k - 1), aisleNodeId(a, b, k))
      }
    }
  }

  // ── Cross-aisle lanes ─────────────────────────────────────────────────────
  // Facilities need their own x positions on the apron lane, so lane x-sets are
  // built per lane and then chained in sorted order.
  const facilityXs: number[] = []
  const spread = (count: number) =>
    Array.from({ length: count }, (_, i) => offsetX + totalWidth * ((i + 0.5) / count))
  const dockXs = spread(config.dockDoors)
  const packXs = spread(config.packStations)
  // Goods-in sits at the far end of the apron from outbound staging, so inbound
  // pallets never cross the outbound flow.
  const receivingX = offsetX + totalWidth * 0.12
  facilityXs.push(...dockXs, ...packXs, receivingX, 0)

  /** nodeId lookup for a lane, keyed by aisle index. */
  const crossNodeByAisle: Map<number, NodeId>[] = []

  const buildLane = (laneId: string, z: number, extraXs: number[], kind: 'cross' | 'staging') => {
    const entries: { x: number; aisle?: number }[] = aisleX.map((x, a) => ({ x, aisle: a }))
    for (const x of extraXs) {
      if (!entries.some((e) => Math.abs(e.x - x) < X_TOLERANCE)) entries.push({ x })
    }
    entries.sort((p, q) => p.x - q.x)

    const byAisle = new Map<number, NodeId>()
    const ids = entries.map((e, i) => {
      const id = `n:${laneId}:x${i}`
      g.addNode({
        id,
        pos: { x: e.x, y: z },
        kind,
        aisle: e.aisle,
      })
      if (e.aisle !== undefined) byAisle.set(e.aisle, id)
      return id
    })
    for (let i = 1; i < ids.length; i++) g.link(ids[i - 1], ids[i])
    return { byAisle, entries, ids }
  }

  for (let c = 0; c <= blocks; c++) {
    const lane = buildLane(`c${c}`, crossZ[c], [], 'cross')
    crossNodeByAisle.push(lane.byAisle)
  }

  // Stitch each aisle's bay chain to the cross aisles bounding its block.
  for (let a = 0; a < aisles; a++) {
    for (let b = 0; b < blocks; b++) {
      g.link(crossNodeByAisle[b].get(a)!, aisleNodeId(a, b, 0))
      g.link(crossNodeByAisle[b + 1].get(a)!, aisleNodeId(a, b, baysPerBlock - 1))
    }
  }

  // ── Apron lane in front of the racking, linking docks/pack to cross aisle 0 ─
  const apron = buildLane('ap', apronLaneZ, facilityXs, 'staging')
  for (let a = 0; a < aisles; a++) {
    g.link(apron.byAisle.get(a)!, crossNodeByAisle[0].get(a)!)
  }
  const apronNodeAt = (x: number): NodeId => {
    let best = apron.ids[0]
    let bestD = Infinity
    apron.entries.forEach((e, i) => {
      const d = Math.abs(e.x - x)
      if (d < bestD) {
        bestD = d
        best = apron.ids[i]
      }
    })
    return best
  }

  // ── Facilities ────────────────────────────────────────────────────────────
  const facilities: Facility[] = []
  const addFacility = (
    kind: Facility['kind'],
    label: string,
    x: number,
    z: number,
    width: number,
    depth: number,
  ) => {
    const id = `${kind}-${facilities.length}`
    const node = `n:${id}`
    g.addNode({ id: node, pos: { x, y: z }, kind: kind === 'dock' ? 'dock' : kind === 'pack' ? 'pack' : 'staging' })
    g.link(node, apronNodeAt(x))
    facilities.push({ id, kind, label, pos: { x, y: z }, node, width, depth })
    return node
  }

  dockXs.forEach((x, i) => addFacility('dock', `Dock ${String(i + 1).padStart(2, '0')}`, x, dockZ, 3.4, 1.0))
  packXs.forEach((x, i) => addFacility('pack', `Pack ${String(i + 1).padStart(2, '0')}`, x, packZ, 3.0, 2.2))
  const receiving = addFacility('staging', 'Inbound Receiving', receivingX, stagingZ, 7, 4)
  const depot = addFacility('staging', 'Outbound Staging', 0, stagingZ, 8, 4)

  // ── Outbound conveyor: pack benches → overhead takeaway → dock sorter ──────
  const conveyor = buildConveyorNetwork({
    packStations: facilities
      .filter((f) => f.kind === 'pack')
      .map((f) => ({ id: f.id, label: f.label, x: f.pos.x, z: f.pos.y, depth: f.depth })),
    docks: facilities
      .filter((f) => f.kind === 'dock')
      .map((f) => ({ id: f.id, label: f.label, x: f.pos.x, z: f.pos.y })),
    bounds: { minX: offsetX - 2, maxX: offsetX + totalWidth + 2 },
    storageMinZ,
    apronDepth,
  })

  // ── Storage locations ─────────────────────────────────────────────────────
  const racks: RackRun[] = []
  const bins: Bin[] = []
  const slotWidth = bayWidth / slotsPerBay
  const goldenLevel = Math.min(levels - 1, 1)
  const storageDepth = blocks * blockLength + (blocks - 1) * crossAisleWidth || 1

  // Scored first, tiered afterwards, so the fast/medium/slow mix is exact and
  // fast movers land in the golden zone near the front — realistic slotting.
  // Capacity is not known yet: it depends on how big the SKU's units turn out.
  const scored: { bin: Omit<Bin, 'sku' | 'capacity'>; score: number }[] = []
  /**
   * Reserve-tier locations, scored and tiered separately from the pick face.
   *
   * Separately because the two tiers answer different questions: the pick face
   * ranks by how easy a location is to reach on foot (golden zone, near the
   * front), while bulk is picked rarely enough that reach barely matters —
   * what matters is that it holds the long tail. Ranking them in one pool
   * would hand the top of the rack a share of the fast movers.
   */
  const reserveScored: { bin: Omit<Bin, 'sku' | 'capacity'>; score: number }[] = []

  for (let a = 0; a < aisles; a++) {
    for (const side of ['L', 'R'] as const) {
      const facing: -1 | 1 = side === 'L' ? 1 : -1
      const faceX = side === 'L' ? aisleX[a] - aisleWidth / 2 : aisleX[a] + aisleWidth / 2
      const x0 = side === 'L' ? faceX - rackDepth : faceX
      const x1 = side === 'L' ? faceX : faceX + rackDepth

      for (let b = 0; b < blocks; b++) {
        racks.push({
          id: `rack-a${a}-${side}-b${b}`,
          aisle: a,
          side,
          block: b,
          x0,
          x1,
          z0: blockStartZ(b),
          z1: blockStartZ(b) + blockLength,
          facing,
        })

        for (let k = 0; k < baysPerBlock; k++) {
          const bay = b * baysPerBlock + k
          const zCenter = bayCenterZ(b, k)
          const node = aisleNodeId(a, b, k)
          const depthScore = 1 - (zCenter - storageMinZ) / storageDepth

          for (let level = 0; level < levels; level++) {
            const levelScore = 1 - Math.abs(level - goldenLevel) / Math.max(1, levels - 1)
            for (let slot = 0; slot < slotsPerBay; slot++) {
              const id = `${config.id}:${a}-${side}-${bay}-${level}-${slot}`
              const code = `A${pad(a + 1)}-${side}${pad(bay + 1)}-${level + 1}${String.fromCharCode(65 + slot)}`
              scored.push({
                bin: {
                  id,
                  code,
                  aisle: a,
                  side,
                  block: b,
                  bay,
                  level,
                  slot,
                  face: {
                    x: faceX,
                    y: levelFaceY(config, level),
                    z: zCenter - bayWidth / 2 + (slot + 0.5) * slotWidth,
                  },
                  pickPoint: { x: aisleX[a], y: zCenter },
                  node,
                },
                score: 0.55 * depthScore + 0.45 * levelScore + rng.float(-0.22, 0.22),
              })
            }
          }

          /*
           * Reserve tier over this same bay. It deliberately shares the bay's
           * nav `node` and `pickPoint`: routing is bay-level, so a picker
           * walks to exactly the same spot on the floor whether the line is
           * at knee height or four levels up. What differs is the time spent
           * there once arrived, which the engine prices per level — not the
           * walk, which is genuinely identical.
           *
           * One slot per bay rather than `slotsPerBay`: a pallet position
           * takes the full bay width, which is why bulk holds so much more
           * per location than the case-pick slots below it.
           */
          for (let r = 0; r < RESERVE_LEVELS; r++) {
            const level = levels + r
            const id = `${config.id}:${a}-${side}-${bay}-${level}-0`
            const code = `A${pad(a + 1)}-${side}${pad(bay + 1)}-R${r + 1}`
            reserveScored.push({
              bin: {
                id,
                code,
                aisle: a,
                side,
                block: b,
                bay,
                level,
                slot: 0,
                face: {
                  x: faceX,
                  y: levelFaceY(config, level),
                  z: zCenter,
                },
                pickPoint: { x: aisleX[a], y: zCenter },
                node,
              },
              // Lower levels of the tier are the ones a truck reaches first,
              // so they carry the marginally faster-moving of the bulk lines.
              score: (RESERVE_LEVELS - r) / RESERVE_LEVELS + rng.float(-0.3, 0.3),
            })
          }
        }
      }
    }
  }

  const ranked = scored.slice().sort((p, q) => q.score - p.score)
  const fastCut = Math.round(ranked.length * TIER_SPLIT.fast)
  const mediumCut = fastCut + Math.round(ranked.length * TIER_SPLIT.medium)
  const tierOf = new Map<string, VelocityTier>()
  ranked.forEach((entry, i) => {
    tierOf.set(entry.bin.id, i < fastCut ? 'fast' : i < mediumCut ? 'medium' : 'slow')
  })

  // Bulk gets its own split — no fast movers at all, by construction.
  const reserveRanked = reserveScored.slice().sort((p, q) => q.score - p.score)
  const reserveMediumCut = Math.round(reserveRanked.length * RESERVE_TIER_SPLIT.medium)
  reserveRanked.forEach((entry, i) => {
    tierOf.set(entry.bin.id, i < reserveMediumCut ? 'medium' : 'slow')
  })
  const isReserveBin = new Set(reserveScored.map((e) => e.bin.id))

  /*
   * Real catalogue entries are handed out round-robin across every aisle,
   * never in `scored`'s raw scan order. Aisle is the outermost of the loops
   * that built `scored` above, so consuming it in that order would pile every
   * real product into aisle 0 alone — the opposite of what "real data in the
   * twin" is supposed to look like. One pass per aisle keeps the assignment
   * itself deterministic (no extra randomness) while spreading real stock
   * across the whole floor.
   */
  const realAssignment = new Map<string, CatalogEntry>()
  if (realCatalog.length > 0) {
    /** Round-robin one pass per aisle, so no aisle is filled before the next starts. */
    const spreadByAisle = (entries: typeof scored) => {
      const byAisle = new Map<number, typeof scored>()
      for (const entry of entries) {
        const list = byAisle.get(entry.bin.aisle)
        if (list) list.push(entry)
        else byAisle.set(entry.bin.aisle, [entry])
      }
      const lists = [...byAisle.values()]
      const out: typeof scored = []
      for (let round = 0; ; round++) {
        let placed = false
        for (const list of lists) {
          if (round >= list.length) continue
          out.push(list[round])
          placed = true
        }
        if (!placed) break
      }
      return out
    }

    /*
     * Real products live on the pick face AND in bulk, interleaved at a fixed
     * cadence.
     *
     * Without this, every real catalogue entry landed on the pick face, so an
     * imported wave — which resolves its lines by the supplier's own item code
     * — could never once send a picker to the reserve tier. Bulk would be real
     * storage that real demand structurally never touched. Long-tail stock
     * genuinely does live only in bulk in a real facility, so interleaving is
     * both the honest model and what makes reserve retrieval visible in the
     * bundled demo wave rather than only in synthetic demand.
     */
    const faceOrder = spreadByAisle(scored)
    const reserveOrder = spreadByAisle(reserveScored)
    const placementOrder: typeof scored = []
    let ri = 0
    faceOrder.forEach((entry, i) => {
      placementOrder.push(entry)
      const due = Math.floor((i + 1) * REAL_ON_RESERVE_SHARE) > Math.floor(i * REAL_ON_RESERVE_SHARE)
      if (due && ri < reserveOrder.length) placementOrder.push(reserveOrder[ri++])
    })

    for (let cursor = 0; cursor < realCatalog.length && cursor < placementOrder.length; cursor++) {
      realAssignment.set(placementOrder[cursor].bin.id, realCatalog[cursor])
    }
  }

  // Clear volume of one storage location, in litres. The height allowance is the
  // shelf pitch less the deck and the lift clearance a picker actually needs.
  const slotLitres = slotWidth * config.rackDepth * (levelHeight * 0.78) * 1000

  let skuSeq = 1
  for (const entry of [...scored, ...reserveScored]) {
    const velocity = tierOf.get(entry.bin.id)!
    const reserve = isReserveBin.has(entry.bin.id)
    const real = realAssignment.get(entry.bin.id)
    const { name, category } = real ?? makeCatalogEntry(rng)

    const [vMin, vMax] = UNIT_VOLUME[velocity]
    const unitVolume = Math.round(rng.float(vMin, vMax) * 10) / 10
    const clearLitres = reserve ? slotLitres * RESERVE_CAPACITY_FACTOR : slotLitres
    const capacity = Math.max(24, Math.round((clearLitres * PACKING_EFFICIENCY) / unitVolume))

    // An empty location still belongs to its SKU — slotting is fixed, the shelf
    // is simply cleared out. That is exactly what a putaway is looking for.
    const [fMin, fMax] = reserve ? RESERVE_OPENING_FILL : OPENING_FILL[velocity]
    const stock = rng.bool(reserve ? RESERVE_EMPTY_SHARE : EMPTY_SHARE)
      ? 0
      : Math.min(capacity, Math.max(8, Math.round(capacity * rng.float(fMin, fMax))))

    const sku: Sku = {
      // A real entry keeps its own identity (a barcode/item code, so real
      // order and receipt data resolves against it); a synthetic one gets the
      // next id off the sequence — only advanced here, so real ids never
      // leave gaps in it.
      id: real?.id ?? `SKU-${String(skuSeq++).padStart(6, '0')}`,
      name,
      category,
      velocity,
      stock,
      stockInitial: stock,
      // Fast movers are replenished far more aggressively than long-tail lines.
      replenPoint: Math.max(2, Math.round(capacity * REPLEN_SHARE[velocity])),
      unitsPerLine: velocity === 'fast' ? rng.int(1, 6) : velocity === 'medium' ? rng.int(1, 3) : rng.int(1, 2),
      price: real?.price ?? Math.round(rng.float(1.2, 89) * 100) / 100,
      unitVolume,
    }
    bins.push({ ...entry.bin, capacity, sku })
  }

  const binsById = new Map(bins.map((b) => [b.id, b]))
  const binBySku = new Map(bins.map((b) => [b.sku.id, b]))
  const binsByNode = new Map<NodeId, Bin[]>()
  for (const bin of bins) {
    const list = binsByNode.get(bin.node)
    if (list) list.push(bin)
    else binsByNode.set(bin.node, [bin])
  }

  const bounds = {
    minX: offsetX - 2,
    maxX: offsetX + totalWidth + 2,
    minZ: storageMinZ - apronDepth,
    maxZ: offsetZ + totalDepth + 2,
  }

  return {
    config,
    bins,
    binsById,
    binsByNode,
    binBySku,
    racks,
    facilities,
    depot,
    receiving,
    conveyor,
    graph: g.build(),
    aisleX,
    crossZ,
    bounds,
    area: Math.round((bounds.maxX - bounds.minX) * (bounds.maxZ - bounds.minZ)),
  }
}

function pad(n: number) {
  return String(n).padStart(2, '0')
}
