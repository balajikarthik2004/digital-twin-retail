import type { WarehouseConfig } from '../warehouse/types'

/**
 * Vertical layout shared by the pick-face racking and the reserve tier stacked
 * above it.
 *
 * Kept as one module — rather than two copies of the same arithmetic, one in
 * {@link ../scene/buildWarehouse} and one in {@link ../scene/shell} — because a
 * roof that clears the pick face but not the reserve tier stacked on top of it
 * would be a building with racking poking through its own steel. Every caller
 * that needs "how tall is the racking" asks this module, never re-derives it.
 *
 * Real basis: a pick face stays reachable on foot, so it stops at
 * `config.levels`; a reserve/overstock tier above it — the same shelf a store
 * backroom keeps overstock on above its pick shelving, or a turret-truck-only
 * bulk level in a DC — is taller per level (pallets, not cases) and is joined
 * to the pick face by a load-rated splice beam with a clear gap below it for
 * the flue-guard mesh, not stacked flush.
 */

/** Reserve pallets need more clearance than a case-pick shelf. */
const RESERVE_LEVEL_HEIGHT_FACTOR = 1.35

/**
 * Shelf levels in the reserve tier — one continuous frame, its own beams and
 * deck at each level, same as the pick face has `config.levels` of its own.
 */
export const RESERVE_LEVELS = 4

/** Clear gap between the top of the pick face and the reserve tier's own posts — where the flue-guard mesh sits. */
export const RESERVE_GAP = 0.5

/** Thickness of the splice beam capping the pick face, at the foot of that gap. */
export const SEPARATOR_BEAM_H = 0.14

/** Section size of the reserve tier's uprights — a hair heavier than the pick face's, since it carries pallets. */
export const RESERVE_POST_SIZE = 0.12

/** Top of the pick-face racking (uprights + shelf levels), before any reserve tier. */
export function pickRackHeight(config: WarehouseConfig): number {
  return 0.16 + config.levels * config.levelHeight
}

/** Clear height of a single reserve level. */
export function reserveLevelHeight(config: WarehouseConfig): number {
  return config.levelHeight * RESERVE_LEVEL_HEIGHT_FACTOR
}

/** Where the reserve tier's own uprights start — above the pick face, the splice beam and the flue gap. */
export function reserveBaseY(config: WarehouseConfig): number {
  return pickRackHeight(config) + RESERVE_GAP + SEPARATOR_BEAM_H
}

/** Deck height of one reserve level (0-indexed, ground level of the reserve tier first). */
export function reserveLevelY(config: WarehouseConfig, level: number): number {
  return reserveBaseY(config) + level * reserveLevelHeight(config)
}

/** Top of the whole racking structure, pick face and reserve tier together — what the roof has to clear. */
export function totalRackHeight(config: WarehouseConfig): number {
  return reserveBaseY(config) + RESERVE_LEVELS * reserveLevelHeight(config)
}

/*
 * ── Level numbering across both tiers ────────────────────────────────────────
 *
 * A `Bin.level` is a single index spanning the whole rack: `0 .. levels-1` is
 * the on-foot pick face, and `levels .. levels + RESERVE_LEVELS - 1` is the
 * reserve tier stacked above it. One flat index rather than a
 * `{ tier, level }` pair, so every existing consumer of `bin.level` — the
 * location code, the putaway ranker, the inspector — keeps working unchanged
 * and simply sees a taller rack.
 */

/** Is this level in the reserve tier rather than the on-foot pick face? */
export function isReserveLevel(config: WarehouseConfig, level: number): boolean {
  return level >= config.levels
}

/** Reserve tier index (0-based within the tier) for a whole-rack level. */
export function reserveTierIndex(config: WarehouseConfig, level: number): number {
  return level - config.levels
}

/** Every level index in the rack, both tiers. */
export function totalLevels(config: WarehouseConfig): number {
  return config.levels + RESERVE_LEVELS
}

/**
 * Height of a location's face, for any level in either tier.
 *
 * The pick face keeps the original `0.16 + level * levelHeight` shelf pitch;
 * the reserve tier sits on its own taller pitch, above the flue gap. Both are
 * derived here so geometry, camera framing and the putaway directions can
 * never disagree about where a shelf actually is.
 */
export function levelFaceY(config: WarehouseConfig, level: number): number {
  if (!isReserveLevel(config, level)) {
    return 0.16 + level * config.levelHeight + config.levelHeight * 0.3
  }
  const r = reserveTierIndex(config, level)
  return reserveLevelY(config, r) + reserveLevelHeight(config) * 0.3
}

/** Deck top a location's stock rests on, for any level in either tier. */
export function levelDeckTop(config: WarehouseConfig, level: number): number {
  if (!isReserveLevel(config, level)) return 0.16 + level * config.levelHeight + 0.045 / 2
  return reserveLevelY(config, reserveTierIndex(config, level)) + 0.08
}

/*
 * ── Mezzanine & its staircases ───────────────────────────────────────────────
 *
 * The walkable floor at the foot of the reserve tier, and the two flights that
 * reach it. Lives here rather than in the scene because BOTH the geometry that
 * draws the stairs and the navigation graph that walks them have to agree on
 * where they are, to the centimetre. A picker climbing a staircase that isn't
 * quite where it is drawn is the exact class of bug this module exists to
 * prevent — the same reason the rack heights are shared rather than re-derived.
 */

/** Ordinary industrial stair proportions, metres. */
export const STEP_RISE = 0.2
export const STEP_RUN = 0.28
export const STAIR_WIDTH = 1.1
/** Clear gap kept between a staircase and the rack it stands beside. */
export const STAIR_RACK_CLEARANCE = 0.4
/** Gap between the two flights of the back switchback. */
export const SWITCHBACK_GAP = 0.5

/** Walking surface of the mezzanine — a hair under the reserve tier's base. */
export function mezzanineFloorY(config: WarehouseConfig): number {
  return reserveBaseY(config) - 0.03
}

/** Number of steps in a flight climbing the full mezzanine height. */
export function mezzanineStairSteps(config: WarehouseConfig): number {
  return Math.max(4, Math.ceil(reserveBaseY(config) / STEP_RISE))
}

export interface StairAccess {
  /** Where the flight meets the ground floor. */
  bottom: { x: number; z: number }
  /** Where it arrives on the mezzanine. */
  top: { x: number; z: number }
  /** Walking length along the flight, metres — the slope, not the run. */
  length: number
}

/**
 * The two staircases onto the mezzanine, derived from the same anchors the
 * geometry uses: both hug the outer face of aisle 0's left-hand rack, where
 * there is open floor all the way to the wall.
 *
 * @param rackX0 outer face (`x0`) of that rack — the side away from the aisle.
 */
export function mezzanineAccess(
  config: WarehouseConfig,
  rackX0: number,
  storageMinZ: number,
  storageMaxZ: number,
): { front: StairAccess; back: StairAccess } {
  const height = reserveBaseY(config)
  const steps = mezzanineStairSteps(config)
  const stairX = rackX0 - (STAIR_WIDTH / 2 + STAIR_RACK_CLEARANCE)

  // Front: one straight flight up out of the apron, arriving at the floor edge.
  const frontRun = steps * STEP_RUN
  const front: StairAccess = {
    bottom: { x: stairX, z: storageMinZ - frontRun },
    top: { x: stairX, z: storageMinZ },
    length: Math.hypot(height, frontRun),
  }

  // Back: a 180° switchback, because the margin behind the last rack row is
  // nowhere near deep enough for a single straight flight at this height.
  const lowerSteps = Math.ceil(steps / 2)
  const upperSteps = steps - lowerSteps
  const stairX2 = stairX - (STAIR_WIDTH + SWITCHBACK_GAP)
  const turnZ = storageMaxZ + lowerSteps * STEP_RUN
  const back: StairAccess = {
    bottom: { x: stairX, z: storageMaxZ },
    top: { x: stairX2, z: turnZ - upperSteps * STEP_RUN },
    length: Math.hypot(height, steps * STEP_RUN) + STAIR_WIDTH,
  }

  return { front, back }
}
