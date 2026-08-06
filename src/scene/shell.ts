import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { ThemeMode } from '../ui/theme'
import type { WarehouseModel } from '../warehouse/types'
import { sceneTheme } from './theme'

/**
 * The building the racking stands in.
 *
 * Everything here is envelope and floor paint — nothing carries data, and nothing
 * is positioned by hand: walls follow `model.bounds`, roof steel follows the
 * clear height the racking needs, and every painted line is derived from the
 * aisle and cross-aisle centrelines the navigation graph already uses. A layout
 * with different dimensions gets a correctly proportioned building for free.
 *
 * Two visibility tricks keep an interior from fighting the camera:
 *
 *   Walls are single-sided and face inwards, so from outside the module you look
 *   straight through them — the architectural cutaway you want from an overview
 *   shot — while from inside an aisle you are properly enclosed.
 *
 *   The ceiling deck faces down for the same reason, and the roof steel is a
 *   separate group the scene hides once the camera climbs above it, so the
 *   plan view is never looking at the underside of a roof.
 */
export interface ShellVisual {
  group: THREE.Group
  /** Roof steel and lighting — hidden by the scene above {@link roofHeight}. */
  roof: THREE.Group
  /** Underside of the roof deck, metres. */
  roofHeight: number
  dispose(): void
}

/** Painted line width, metres — a real floor line is about a hand wide. */
const LINE_W = 0.12
/**
 * Clearance kept between the top of the racking and the roof deck, and the floor
 * a small module still gets. 10 m clear is ordinary for an ambient DC, and it is
 * also what keeps the pack-line and dock camera presets — both of which sit 7-9 m
 * up — below the roof steel rather than inside it.
 */
const HEAD_ROOM = 3.2
const MIN_CLEAR_HEIGHT = 10
/** Spacing of roof trusses and of the high-bay fixtures along an aisle. */
const TRUSS_PITCH = 7.5
const FIXTURE_PITCH = 9

export function buildShell(model: WarehouseModel, themeMode: ThemeMode): ShellVisual {
  const { config, bounds } = model
  const T = sceneTheme(themeMode).shell
  const group = new THREE.Group()
  group.name = 'shell'
  const roof = new THREE.Group()
  roof.name = 'roof'
  group.add(roof)

  const disposables: (THREE.BufferGeometry | THREE.Material)[] = []

  // The building is the footprint plus a working margin, so the perimeter curb
  // and the dock apron are inside the walls rather than pressed against them.
  const minX = bounds.minX - 2.5
  const maxX = bounds.maxX + 2.5
  const minZ = bounds.minZ - 2.5
  const maxZ = bounds.maxZ + 2.5
  const width = maxX - minX
  const depth = maxZ - minZ
  const centerX = (minX + maxX) / 2
  const centerZ = (minZ + maxZ) / 2

  const rackHeight = 0.16 + config.levels * config.levelHeight
  const clearHeight = Math.max(rackHeight + HEAD_ROOM, MIN_CLEAR_HEIGHT)

  // ── Walls ─────────────────────────────────────────────────────────────────
  // Single-sided and facing in. `PlaneGeometry` faces +z, so each wall is turned
  // to point at the middle of the building; back faces are culled, which is what
  // makes the shell vanish when you look at it from outside.
  const wallMat = new THREE.MeshStandardMaterial({
    color: T.wall,
    roughness: 0.94,
    metalness: 0.02,
    side: THREE.FrontSide,
  })
  const baseMat = new THREE.MeshStandardMaterial({
    color: T.wallBase,
    roughness: 0.86,
    metalness: 0.1,
    side: THREE.FrontSide,
  })
  disposables.push(wallMat, baseMat)

  const BASE_H = 1.1
  const walls: { w: number; x: number; z: number; ry: number }[] = [
    { w: width, x: centerX, z: minZ, ry: 0 },
    { w: width, x: centerX, z: maxZ, ry: Math.PI },
    { w: depth, x: minX, z: centerZ, ry: Math.PI / 2 },
    { w: depth, x: maxX, z: centerZ, ry: -Math.PI / 2 },
  ]

  for (const wall of walls) {
    const geo = new THREE.PlaneGeometry(wall.w, clearHeight)
    const mesh = new THREE.Mesh(geo, wallMat)
    mesh.position.set(wall.x, clearHeight / 2, wall.z)
    mesh.rotation.y = wall.ry
    mesh.receiveShadow = true
    group.add(mesh)
    disposables.push(geo)

    // Impact skirt, lifted a hair off the wall so it never z-fights with it.
    const skirtGeo = new THREE.PlaneGeometry(wall.w, BASE_H)
    const skirt = new THREE.Mesh(skirtGeo, baseMat)
    skirt.position.set(
      wall.x + Math.sin(wall.ry) * 0.02,
      BASE_H / 2,
      wall.z + Math.cos(wall.ry) * 0.02,
    )
    skirt.rotation.y = wall.ry
    group.add(skirt)
    disposables.push(skirtGeo)
  }

  // ── Roof deck ─────────────────────────────────────────────────────────────
  // Rotated to face down, so a top-down camera looks straight through it.
  const deckGeo = new THREE.PlaneGeometry(width, depth)
  deckGeo.rotateX(Math.PI / 2)
  const deckMat = new THREE.MeshStandardMaterial({
    color: T.ceiling,
    roughness: 0.98,
    metalness: 0,
    side: THREE.FrontSide,
  })
  const deck = new THREE.Mesh(deckGeo, deckMat)
  deck.position.set(centerX, clearHeight, centerZ)
  roof.add(deck)
  disposables.push(deckGeo, deckMat)

  // ── Roof steel: trusses across the module, purlins along it ───────────────
  const trussMat = new THREE.MeshStandardMaterial({
    color: T.truss,
    roughness: 0.55,
    metalness: 0.7,
  })
  disposables.push(trussMat)

  const steel: THREE.BufferGeometry[] = []
  const chordY = clearHeight - 0.28
  const bottomY = clearHeight - 1.15
  const trussCount = Math.max(2, Math.round(depth / TRUSS_PITCH))

  for (let i = 0; i <= trussCount; i++) {
    const z = minZ + (depth * i) / trussCount
    // Top and bottom chords, plus verticals — enough of a lattice to read as a
    // truss from the floor without paying for a full web.
    steel.push(boxAt(centerX, chordY, z, width, 0.16, 0.14))
    steel.push(boxAt(centerX, bottomY, z, width, 0.13, 0.11))
    const struts = Math.max(2, Math.round(width / 4))
    for (let s = 0; s <= struts; s++) {
      steel.push(boxAt(minX + (width * s) / struts, (chordY + bottomY) / 2, z, 0.09, chordY - bottomY, 0.09))
    }
  }

  // Purlins tie the trusses together; two runs is enough to read the direction.
  for (const x of [centerX - width * 0.26, centerX + width * 0.26]) {
    steel.push(boxAt(x, chordY - 0.22, centerZ, 0.1, 0.1, depth))
  }

  const steelMerged = mergeGeometries(steel)
  steel.forEach((g) => g.dispose())
  if (steelMerged) {
    roof.add(new THREE.Mesh(steelMerged, trussMat))
    disposables.push(steelMerged)
  }

  // ── High-bay lighting ─────────────────────────────────────────────────────
  // One run of fixtures per aisle, so the aisles are the lit part of the floor —
  // which is both how a real facility is lit and where the work happens.
  const housingMat = new THREE.MeshStandardMaterial({
    color: T.fixture,
    roughness: 0.4,
    metalness: 0.6,
  })
  const lensMat = new THREE.MeshStandardMaterial({
    color: T.fixtureLens,
    emissive: new THREE.Color(T.fixtureLens),
    emissiveIntensity: T.fixtureEmissive,
    roughness: 0.3,
  })
  disposables.push(housingMat, lensMat)

  const housings: THREE.BufferGeometry[] = []
  const lenses: THREE.BufferGeometry[] = []
  const fixtureY = bottomY - 0.2
  const rows = Math.max(1, Math.round(depth / FIXTURE_PITCH))

  const lightXs = [...model.aisleX]
  // One extra run down the middle of the dock apron, which has no aisle of its own.
  const apronZ = model.crossZ[0] - config.crossAisleWidth / 2 - config.apronDepth * 0.5
  for (let r = 0; r < rows; r++) {
    const z = minZ + depth * ((r + 0.5) / rows)
    for (const x of lightXs) {
      housings.push(boxAt(x, fixtureY, z, 0.34, 0.16, 1.5))
      lenses.push(boxAt(x, fixtureY - 0.1, z, 0.26, 0.05, 1.42))
    }
  }
  for (const x of [centerX - width * 0.3, centerX, centerX + width * 0.3]) {
    housings.push(boxAt(x, fixtureY, apronZ, 0.34, 0.16, 1.5))
    lenses.push(boxAt(x, fixtureY - 0.1, apronZ, 0.26, 0.05, 1.42))
  }

  for (const [geos, mat] of [
    [housings, housingMat],
    [lenses, lensMat],
  ] as const) {
    const merged = mergeGeometries(geos)
    geos.forEach((g) => g.dispose())
    if (!merged) continue
    roof.add(new THREE.Mesh(merged, mat))
    disposables.push(merged)
  }

  // ── Painted floor markings ────────────────────────────────────────────────
  const markMat = new THREE.MeshBasicMaterial({
    color: T.marking,
    transparent: true,
    opacity: T.markingOpacity,
    depthWrite: false,
  })
  disposables.push(markMat)

  const marks: THREE.BufferGeometry[] = []
  const half = config.crossAisleWidth / 2
  const storageMinZ = model.crossZ[0] - half
  const storageMaxZ = model.crossZ[model.crossZ.length - 1] + half

  // Aisle edge lines, drawn block by block so they stop at every cross aisle
  // instead of painting over the junctions.
  for (const x of model.aisleX) {
    for (let b = 0; b < model.crossZ.length - 1; b++) {
      const z0 = model.crossZ[b] + half
      const z1 = model.crossZ[b + 1] - half
      const len = z1 - z0
      if (len <= 0.4) continue
      for (const dx of [-1, 1]) {
        marks.push(planeAt(x + dx * (config.aisleWidth / 2 - 0.16), (z0 + z1) / 2, LINE_W, len))
      }
    }
  }

  // Cross-aisle edges, running the full width of the storage block.
  const crossSpan = bounds.maxX - bounds.minX
  for (const z of model.crossZ) {
    for (const dz of [-1, 1]) {
      marks.push(planeAt((bounds.minX + bounds.maxX) / 2, z + dz * (half - 0.16), crossSpan, LINE_W))
    }
  }

  // Threshold line across the front of the storage block, then a marked
  // pedestrian walkway between the racking and the dock doors.
  marks.push(planeAt((bounds.minX + bounds.maxX) / 2, storageMinZ - 0.5, crossSpan, LINE_W))
  marks.push(planeAt((bounds.minX + bounds.maxX) / 2, storageMaxZ + 0.5, crossSpan, LINE_W))

  const walkZ = apronZ
  const WALK_W = 1.3
  const walkX0 = bounds.minX + 1
  const walkX1 = bounds.maxX - 1
  const walkLen = walkX1 - walkX0
  if (walkLen > 4) {
    for (const dz of [-1, 1]) {
      marks.push(planeAt((walkX0 + walkX1) / 2, walkZ + (dz * WALK_W) / 2, walkLen, LINE_W))
    }
    // Rungs, so it reads as a walkway rather than two stray lines.
    const rungs = Math.floor(walkLen / 1.4)
    for (let i = 1; i < rungs; i++) {
      marks.push(planeAt(walkX0 + (walkLen * i) / rungs, walkZ, LINE_W * 0.8, WALK_W))
    }
  }

  // Keep-clear box in front of every dock door.
  for (const f of model.facilities) {
    if (f.kind !== 'dock') continue
    const w = f.width + 0.8
    const d = 2.2
    const z = f.pos.y + d / 2 + 0.2
    marks.push(planeAt(f.pos.x, z - d / 2, w, LINE_W))
    marks.push(planeAt(f.pos.x, z + d / 2, w, LINE_W))
    for (const dx of [-1, 1]) {
      marks.push(planeAt(f.pos.x + (dx * w) / 2, z, LINE_W, d))
    }
  }

  const marksMerged = mergeGeometries(marks)
  marks.forEach((g) => g.dispose())
  if (marksMerged) {
    const mesh = new THREE.Mesh(marksMerged, markMat)
    /*
     * Four near-coplanar translucent layers share this slab: the floor itself,
     * the painted aisle lanes at 0.012, these markings, and the route ribbons
     * from 0.03 up. Height alone will not order them — every one of them is in
     * the transparent queue, where `renderOrder` beats distance — so the stack is
     * declared explicitly: lanes 0, markings 1, pick ribbons 4, putaway 6.
     * Depth writing stays off so nothing in the stack occludes the layer above it.
     */
    mesh.position.y = 0.02
    mesh.renderOrder = 1
    group.add(mesh)
    disposables.push(marksMerged)
  }

  return {
    group,
    roof,
    roofHeight: clearHeight,
    dispose() {
      for (const d of disposables) d.dispose()
    },
  }
}

function boxAt(x: number, y: number, z: number, w: number, h: number, d: number): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(w, h, d)
  geo.translate(x, y, z)
  return geo
}

/** Horizontal plane, already rotated flat and translated. */
function planeAt(x: number, z: number, w: number, d: number): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(w, d)
  geo.rotateX(-Math.PI / 2)
  geo.translate(x, 0, z)
  return geo
}
