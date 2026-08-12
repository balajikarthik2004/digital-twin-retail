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
