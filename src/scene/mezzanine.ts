import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { ThemeMode } from '../ui/theme'
import type { WarehouseModel } from '../warehouse/types'
import { reserveBaseY } from '../warehouse/rackGeometry'
import { sceneTheme } from './theme'

/**
 * The mezzanine that makes the reserve tier walkable: a glass/grating floor
 * at its base, spanning the storage block, and two staircases up to it — a
 * straight flight at the front, hugging the end of the first rack row, and a
 * switchback in a back corner where there isn't room for a straight run.
 *
 * The pick face and the reserve tier stay two separate rack units exactly as
 * before — this only adds the floor a picker would actually stand on to work
 * the reserve tier by hand, and the stairs that get them there. Everything
 * here is built once into its own group, which the caller nests under the
 * same `reserve` group everything else in the tier already lives in, so the
 * whole mezzanine hides together with the racking above it in a
 * near-vertical plan view (see `WarehouseScene.syncReserveTier`) instead of
 * capping the module like a lid.
 */
export interface MezzanineVisual {
  group: THREE.Group
  dispose(): void
}

/** Ordinary industrial stair proportions, metres. */
const STEP_RISE = 0.2
const STEP_RUN = 0.28
const STAIR_WIDTH = 1.1
/** Handrail height above each tread. */
const RAIL_HEIGHT = 0.95
/** Clear gap kept between a staircase and the rack it stands beside. */
const RACK_CLEARANCE = 0.4
/** Gap between the two flights of the back switchback, and its landing depth. */
const SWITCHBACK_GAP = 0.5

export function buildMezzanine(model: WarehouseModel, themeMode: ThemeMode): MezzanineVisual {
  const theme = sceneTheme(themeMode)
  const M = theme.mezzanine
  const { config } = model
  const group = new THREE.Group()
  group.name = 'mezzanine'
  const disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = []

  const half = config.crossAisleWidth / 2
  const storageMinZ = model.crossZ[0] - half
  const storageMaxZ = model.crossZ[model.crossZ.length - 1] + half
  const floorY = reserveBaseY(config) - 0.03
  const totalHeight = reserveBaseY(config)

  // ── Glass/grating floor over the storage block ─────────────────────────────
  // Sized to the racking, not the whole building — the mezzanine has no
  // business hovering over the dock aisle or the pack benches below it.
  const floorW = model.bounds.maxX - model.bounds.minX - 1
  const floorD = storageMaxZ - storageMinZ
  const centerX = (model.bounds.minX + model.bounds.maxX) / 2
  const centerZ = (storageMinZ + storageMaxZ) / 2

  const gratingTexture = makeGratingTexture(M)
  gratingTexture.repeat.set(Math.max(1, Math.round(floorW / 0.45)), Math.max(1, Math.round(floorD / 0.45)))
  disposables.push(gratingTexture)

  const floorMat = new THREE.MeshPhysicalMaterial({
    color: M.floorTint,
    map: gratingTexture,
    transparent: true,
    opacity: M.floorOpacity,
    roughness: 0.18,
    metalness: 0.05,
    clearcoat: 0.55,
    clearcoatRoughness: 0.25,
    side: THREE.DoubleSide,
    depthWrite: false,
  })
  disposables.push(floorMat)

  const floorGeo = new THREE.PlaneGeometry(floorW, floorD)
  floorGeo.rotateX(-Math.PI / 2)
  const floor = new THREE.Mesh(floorGeo, floorMat)
  floor.position.set(centerX, floorY, centerZ)
  // Coplanar transparent layers are ordered explicitly elsewhere in the scene
  // (see `shell.ts`); this one sits well above all of them, but keeping the
  // same convention avoids it fighting the flue-guard mesh right beside it.
  floor.renderOrder = 3
  floor.receiveShadow = true
  group.add(floor)
  disposables.push(floorGeo)

  const treadMat = new THREE.MeshStandardMaterial({ color: M.stairTread, roughness: 0.55, metalness: 0.5 })
  const railMat = new THREE.MeshStandardMaterial({ color: theme.safety.hazardYellow, roughness: 0.4, metalness: 0.5 })
  disposables.push(treadMat, railMat)

  // Both staircases hug aisle 0's left-hand rack — its outer face (`x0`,
  // away from the aisle) is open floor all the way to the side wall, which
  // is exactly the clearance a stair needs and the one thing "in the open
  // apron somewhere" never guaranteed.
  const anchorRack = (block: number) =>
    model.racks.find((r) => r.aisle === 0 && r.side === 'L' && r.block === block)
  const frontRack = anchorRack(0)
  const backRack = anchorRack(config.blocks - 1) ?? frontRack

  // ── Front staircase: one straight flight up from the apron ─────────────────
  if (frontRack) {
    const stairX = frontRack.x0 - (STAIR_WIDTH / 2 + RACK_CLEARANCE)
    const steps = Math.max(4, Math.ceil(totalHeight / STEP_RISE))
    const rise = totalHeight / steps
    const runLength = steps * STEP_RUN
    // The flight's ground-level end sits out in the apron; it climbs toward
    // the rack, arriving at full height exactly at `storageMinZ` — the
    // floor's own edge. Passing `storageMinZ` itself as the *start* here
    // would put the tallest step out in the apron and the shortest step
    // under the floor, which is backwards and leaves the stair not actually
    // touching the mezzanine it's supposed to reach.
    const { stepGeos, railGeos } = addFlight({
      x: stairX,
      zStart: storageMinZ - runLength,
      zDir: 1,
      baseY: 0,
      steps,
      rise,
      run: STEP_RUN,
      width: STAIR_WIDTH,
      railHeight: RAIL_HEIGHT,
    })
    addMerged(group, disposables, stepGeos, treadMat, true)
    addMerged(group, disposables, railGeos, railMat, true)
  }

  // ── Back staircase: a 180° switchback tucked into the back corner ──────────
  // The margin behind the last rack row is only a few metres deep — nowhere
  // near enough for a single straight flight at this height — so it folds
  // back on itself around a landing instead, the standard real-world fix for
  // a tall mezzanine stair in a tight corner.
  if (backRack) {
    const stairX1 = backRack.x0 - (STAIR_WIDTH / 2 + RACK_CLEARANCE)
    const stairX2 = stairX1 - (STAIR_WIDTH + SWITCHBACK_GAP)
    const totalSteps = Math.max(4, Math.ceil(totalHeight / STEP_RISE))
    const lowerSteps = Math.ceil(totalSteps / 2)
    const upperSteps = totalSteps - lowerSteps
    const rise = totalHeight / totalSteps

    // Flight 1 climbs away from the racking, into the back margin.
    const lower = addFlight({
      x: stairX1,
      zStart: storageMaxZ,
      zDir: 1,
      baseY: 0,
      steps: lowerSteps,
      rise,
      run: STEP_RUN,
      width: STAIR_WIDTH,
      railHeight: RAIL_HEIGHT,
    })
    // Flight 2 climbs back toward the racking, arriving at the mezzanine edge.
    const upper = addFlight({
      x: stairX2,
      zStart: storageMaxZ + lowerSteps * STEP_RUN,
      zDir: -1,
      baseY: lowerSteps * rise,
      steps: upperSteps,
      rise,
      run: STEP_RUN,
      width: STAIR_WIDTH,
      railHeight: RAIL_HEIGHT,
    })
    addMerged(group, disposables, [...lower.stepGeos, ...upper.stepGeos], treadMat, true)

    // Landing platform joining the two flights, plus its own guard rail on
    // the open side.
    const landingZ = storageMaxZ + lowerSteps * STEP_RUN + STAIR_WIDTH / 2
    const landingY = lowerSteps * rise
    const landingWidth = stairX1 - stairX2 + STAIR_WIDTH
    const landingGeo = boxAt((stairX1 + stairX2) / 2, landingY, landingZ, landingWidth, 0.08, STAIR_WIDTH)
    addMerged(group, disposables, [landingGeo], treadMat, true)

    const railGeos = [...lower.railGeos, ...upper.railGeos]
    railGeos.push(
      boxAt((stairX1 + stairX2) / 2, landingY + RAIL_HEIGHT, landingZ + STAIR_WIDTH / 2, landingWidth, 0.05, 0.05),
    )
    addMerged(group, disposables, railGeos, railMat, true)
  }

  return {
    group,
    dispose() {
      for (const d of disposables) d.dispose()
    },
  }
}

/**
 * One straight flight of stairs plus its handrails, as loose geometry the
 * caller merges (so a switchback can combine two flights into one mesh
 * rather than paying for a draw call each).
 *
 * `zStart` is the flight's *bottom* — `baseY`, at ground level for a
 * straight run, or the landing height for a switchback's return flight —
 * never the top it climbs to. `zDir` is which way `z` moves while climbing:
 * the flight's full-height end lands at `zStart + zDir * steps * run`, and
 * that point is what has to line up with wherever this flight is meant to
 * arrive (a floor edge, a landing). Passing the *destination* as `zStart`
 * inverts the whole flight — the tallest step ends up at the far end and
 * the shortest step ends up at the destination, which doesn't reach it.
 */
function addFlight(params: {
  x: number
  zStart: number
  zDir: 1 | -1
  baseY: number
  steps: number
  rise: number
  run: number
  width: number
  railHeight: number
}): { stepGeos: THREE.BufferGeometry[]; railGeos: THREE.BufferGeometry[] } {
  const { x, zStart, zDir, baseY, steps, rise, run, width, railHeight } = params
  const stepGeos: THREE.BufferGeometry[] = []
  for (let i = 0; i < steps; i++) {
    // Stacked cumulative-height blocks, same low-poly technique as the rest
    // of the scene's scenery — the stepped silhouette is what reads, not the
    // hidden faces underneath it.
    const stepH = (i + 1) * rise
    const z0 = zStart + zDir * i * run
    stepGeos.push(boxAt(x, baseY + stepH / 2, z0 + (zDir * run) / 2, width, stepH, run))
  }

  const runLength = steps * run
  const totalRise = steps * rise
  const railLen = Math.hypot(totalRise, runLength)
  const railDir = new THREE.Vector3(0, totalRise, zDir * runLength).normalize()
  const railQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), railDir)

  const railGeos: THREE.BufferGeometry[] = []
  for (const side of [-1, 1] as const) {
    const rx = x + side * (width / 2 + 0.03)
    const rail = new THREE.BoxGeometry(0.05, 0.05, railLen)
    rail.applyQuaternion(railQuat)
    rail.translate(rx, baseY + railHeight + totalRise / 2, zStart + (zDir * runLength) / 2)
    railGeos.push(rail)

    const postCount = Math.max(3, Math.round(runLength / 1.4))
    for (let p = 0; p <= postCount; p++) {
      const t = p / postCount
      railGeos.push(boxAt(rx, baseY + t * totalRise + railHeight / 2, zStart + zDir * t * runLength, 0.04, railHeight, 0.04))
    }
  }

  return { stepGeos, railGeos }
}

/** Merge a batch of loose geometry into one mesh and add it, tracking disposal. */
function addMerged(
  group: THREE.Group,
  disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[],
  geos: THREE.BufferGeometry[],
  material: THREE.Material,
  cast: boolean,
): void {
  const merged = mergeGeometries(geos)
  geos.forEach((g) => g.dispose())
  if (!merged) return
  const mesh = new THREE.Mesh(merged, material)
  mesh.castShadow = cast
  mesh.receiveShadow = true
  group.add(mesh)
  disposables.push(merged)
}

/**
 * Bar-grating look: closely spaced bearing bars one way, sparser cross bars
 * the other — the real pattern of a steel mezzanine grating panel, not just
 * a generic grid. Baked as an opaque tile with the pattern drawn in colour,
 * so the material's own transparency governs how see-through the floor is;
 * baking the pattern into the canvas's alpha channel instead would leave
 * nearly all of it fully transparent rather than translucent, which is
 * invisible, not glass.
 */
function makeGratingTexture(theme: { grating: number }): THREE.Texture {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, size, size)

  ctx.strokeStyle = hex(theme.grating)

  // Bearing bars: the closely spaced run a real grating panel is mostly made
  // of.
  ctx.lineWidth = 2
  ctx.globalAlpha = 0.85
  const bars = 6
  for (let i = 0; i <= bars; i++) {
    const x = (size * i) / bars
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, size)
    ctx.stroke()
  }

  // Cross bars: far fewer of them — the rungs that actually tie the bearing
  // bars together, not another full grid.
  ctx.lineWidth = 2.4
  ctx.globalAlpha = 0.65
  for (const frac of [0.28, 0.72]) {
    ctx.beginPath()
    ctx.moveTo(0, size * frac)
    ctx.lineTo(size, size * frac)
    ctx.stroke()
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function hex(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`
}

function boxAt(x: number, y: number, z: number, w: number, h: number, d: number): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(w, h, d)
  geo.translate(x, y, z)
  return geo
}
