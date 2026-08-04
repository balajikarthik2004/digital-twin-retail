import type { NavGraph, NodeId, Vec2 } from '../pathfinding/types'

export type VelocityTier = 'fast' | 'medium' | 'slow'

/**
 * Declarative warehouse definition. Everything downstream — geometry, bins,
 * SKUs and the navigation graph — is derived from this, so swapping in a real
 * facility means replacing this JSON (see `src/data/layouts.ts`).
 * All linear dimensions are metres.
 */
export interface WarehouseConfig {
  id: string
  name: string
  /** Number of picking aisles running front-to-back. */
  aisles: number
  /** Clear walkable width of a picking aisle. */
  aisleWidth: number
  /** Depth of a single rack run (one side of an aisle). */
  rackDepth: number
  /** Width of one rack bay along the aisle. */
  bayWidth: number
  /** Bays in a block, i.e. between two cross aisles. */
  baysPerBlock: number
  /** Blocks stacked front-to-back. `blocks + 1` cross aisles are generated. */
  blocks: number
  /** Shelf levels per bay. */
  levels: number
  levelHeight: number
  /** Storage locations across one bay face at one level. */
  slotsPerBay: number
  crossAisleWidth: number
  /** Depth of the front staging/dock apron in front of cross aisle 0. */
  apronDepth: number
  dockDoors: number
  packStations: number
  /** Picker walking speed, m/s. */
  pickerSpeed: number
  /** Fixed handling seconds per pick line, before per-unit time. */
  pickTimeSec: number
  /** Additional seconds per unit picked. */
  perUnitTimeSec: number
  /** Deterministic seed for SKU/slotting generation. */
  seed: number
}

export interface Sku {
  id: string
  name: string
  category: string
  velocity: VelocityTier
  /** Units currently on hand. Mutated as the simulation picks; restored on reset. */
  stock: number
  /** On-hand at generation time, so a reset can restore the twin exactly. */
  stockInitial: number
  /** Below this on-hand level the location is flagged for replenishment. */
  replenPoint: number
  /** Typical units per order line. */
  unitsPerLine: number
  /** Retail price, purely cosmetic for the inspector card. */
  price: number
}

/** A single storage location. */
export interface Bin {
  id: string
  /** Operator-facing location code, e.g. `A03-R-14-2`. */
  code: string
  aisle: number
  side: 'L' | 'R'
  block: number
  /** Global bay index within the aisle (across all blocks). */
  bay: number
  level: number
  slot: number
  /** Centre of the bin face, world coords (x, y=up, z=depth). */
  face: { x: number; y: number; z: number }
  /** Floor point in the aisle where the picker stands. */
  pickPoint: Vec2
  /** Nav graph node the picker routes to. */
  node: NodeId
  sku: Sku
}

/** One contiguous run of racking, used to build geometry. */
export interface RackRun {
  id: string
  aisle: number
  side: 'L' | 'R'
  block: number
  /** Axis-aligned footprint. */
  x0: number
  x1: number
  z0: number
  z1: number
  /** Direction the shelf openings face: -1 = towards -x, +1 = towards +x. */
  facing: -1 | 1
}

export interface Facility {
  id: string
  kind: 'dock' | 'pack' | 'staging'
  label: string
  pos: Vec2
  node: NodeId
  width: number
  depth: number
}

export interface WarehouseModel {
  config: WarehouseConfig
  bins: Bin[]
  binsById: Map<string, Bin>
  /** Bins grouped by the nav node the picker stands at. */
  binsByNode: Map<NodeId, Bin[]>
  racks: RackRun[]
  facilities: Facility[]
  /** Default route start/end node (the outbound staging lane). */
  depot: NodeId
  graph: NavGraph
  /** Aisle centreline x positions, indexed by aisle. */
  aisleX: number[]
  /** Cross-aisle centreline z positions, indexed by cross aisle. */
  crossZ: number[]
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number }
  /** Overall floor footprint in m². */
  area: number
}
