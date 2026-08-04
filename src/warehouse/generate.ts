import { NavGraphBuilder } from '../pathfinding/graph'
import type { NodeId } from '../pathfinding/types'
import { makeCatalogEntry } from './catalog'
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
 */
export function generateWarehouse(config: WarehouseConfig): WarehouseModel {
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
  facilityXs.push(...dockXs, ...packXs, 0)

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
  const depot = addFacility('staging', 'Outbound Staging', 0, stagingZ, 8, 4)

  // ── Storage locations ─────────────────────────────────────────────────────
  const racks: RackRun[] = []
  const bins: Bin[] = []
  const slotWidth = bayWidth / slotsPerBay
  const goldenLevel = Math.min(levels - 1, 1)
  const storageDepth = blocks * blockLength + (blocks - 1) * crossAisleWidth || 1

  // Scored first, tiered afterwards, so the fast/medium/slow mix is exact and
  // fast movers land in the golden zone near the front — realistic slotting.
  const scored: { bin: Omit<Bin, 'sku'>; score: number }[] = []

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
                    y: 0.16 + level * levelHeight + levelHeight * 0.3,
                    z: zCenter - bayWidth / 2 + (slot + 0.5) * slotWidth,
                  },
                  pickPoint: { x: aisleX[a], y: zCenter },
                  node,
                },
                score: 0.55 * depthScore + 0.45 * levelScore + rng.float(-0.22, 0.22),
              })
            }
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

  let skuSeq = 1
  for (const entry of scored) {
    const velocity = tierOf.get(entry.bin.id)!
    const { name, category } = makeCatalogEntry(rng)
    const stock =
      velocity === 'fast' ? rng.int(120, 900) : velocity === 'medium' ? rng.int(40, 260) : rng.int(4, 70)
    const sku: Sku = {
      id: `SKU-${String(skuSeq++).padStart(6, '0')}`,
      name,
      category,
      velocity,
      stock,
      stockInitial: stock,
      // Fast movers are replenished far more aggressively than long-tail lines.
      replenPoint: Math.max(2, Math.round(stock * (velocity === 'fast' ? 0.22 : velocity === 'medium' ? 0.15 : 0.1))),
      unitsPerLine: velocity === 'fast' ? rng.int(1, 6) : velocity === 'medium' ? rng.int(1, 3) : rng.int(1, 2),
      price: Math.round(rng.float(1.2, 89) * 100) / 100,
    }
    bins.push({ ...entry.bin, sku })
  }

  const binsById = new Map(bins.map((b) => [b.id, b]))
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
    racks,
    facilities,
    depot,
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
