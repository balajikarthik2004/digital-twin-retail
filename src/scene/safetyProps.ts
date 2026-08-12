import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { ThemeMode } from '../ui/theme'
import type { WarehouseModel } from '../warehouse/types'
import { disposeSprite } from './labels'
import { sceneTheme, type SceneTheme } from './theme'

/**
 * Site safety kit: the parts of a real facility that have nothing to do with
 * throughput but everything to do with what makes it read as a working
 * building rather than a rendering of shelves — rack-end impact guards and a
 * couple of reach trucks staged near the aisles that actually service the
 * reserve tier.
 *
 * Purely decorative: nothing here is derived from bin state or read back by
 * the simulation, so it is built once per layout and never touched again.
 */
export interface SafetyVisual {
  group: THREE.Group
  dispose(): void
}

/** Rack-end guard footprint, metres — big enough to read as a bollard, not a post. */
const GUARD_W = 0.22
const GUARD_H = 0.55

/** How many aisles apart the parked reach trucks are — spread across the module, not clustered. */
const TRUCK_SPACING_AISLES = 3

export function buildSafetyProps(model: WarehouseModel, themeMode: ThemeMode): SafetyVisual {
  const theme = sceneTheme(themeMode).safety
  const group = new THREE.Group()
  group.name = 'safety'
  const disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = []

  // ── Rack-end impact guards ─────────────────────────────────────────────────
  // Real racking takes its worst hits at the end of a run, where a pallet
  // truck turns out of the cross aisle — so that is exactly where the
  // hazard-striped guards go, not spread along the whole face.
  const guardGeos: THREE.BufferGeometry[] = []
  for (const rack of model.racks) {
    const faceX = rack.facing === 1 ? rack.x1 : rack.x0
    for (const z of [rack.z0, rack.z1]) {
      guardGeos.push(
        boxAt(faceX - rack.facing * (GUARD_W / 2 + 0.01), GUARD_H / 2, z, GUARD_W, GUARD_H, GUARD_W),
      )
    }
  }
  const hazardTexture = makeHazardTexture(theme)
  hazardTexture.repeat.set(1.4, 2.6)
  disposables.push(hazardTexture)
  const guardMat = new THREE.MeshStandardMaterial({ map: hazardTexture, roughness: 0.55, metalness: 0.15 })
  disposables.push(guardMat)
  const guardMerged = mergeGeometries(guardGeos)
  guardGeos.forEach((g) => g.dispose())
  if (guardMerged) {
    const mesh = new THREE.Mesh(guardMerged, guardMat)
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)
    disposables.push(guardMerged)
  }

  // ── Reach trucks staged near the reserve aisles ────────────────────────────
  // Only the reserve tier is turret-truck territory, so a couple of trucks
  // parked at the head of a picking aisle is what tells that story without
  // scattering a whole fleet across the floor.
  const truckTemplate = buildReachTruck(theme)
  disposables.push(...truckTemplate.disposables)
  const frontZ = model.crossZ[0] ?? model.bounds.minZ
  for (let a = 1; a < model.aisleX.length; a += TRUCK_SPACING_AISLES) {
    const truck = truckTemplate.group.clone(true)
    truck.position.set(
      model.aisleX[a] - model.config.aisleWidth * 0.22,
      0,
      frontZ + model.config.bayWidth * 0.55,
    )
    group.add(truck)
  }

  return {
    group,
    dispose() {
      for (const d of disposables) d.dispose()
      group.traverse((obj) => {
        if (obj instanceof THREE.Sprite) disposeSprite(obj)
      })
    },
  }
}

/**
 * One reach truck, built once and cloned for every parked instance — clones
 * share the same geometry/material references, so N trucks cost one extra
 * draw call each rather than N times the memory.
 *
 * Local space: origin at ground contact, forks pointing toward +Z, so a
 * caller only ever has to set position and, if it wants the truck facing the
 * other way down the aisle, `rotation.y = Math.PI`.
 */
function buildReachTruck(theme: SceneTheme['safety']): {
  group: THREE.Group
  disposables: (THREE.BufferGeometry | THREE.Material)[]
} {
  const bodyMat = new THREE.MeshStandardMaterial({ color: theme.truckBody, roughness: 0.5, metalness: 0.35 })
  const mastMat = new THREE.MeshStandardMaterial({ color: theme.truckMast, roughness: 0.4, metalness: 0.6 })
  const wheelMat = new THREE.MeshStandardMaterial({ color: theme.truckWheel, roughness: 0.85, metalness: 0.1 })
  const beaconMat = new THREE.MeshStandardMaterial({
    color: theme.beacon,
    emissive: new THREE.Color(theme.beacon),
    emissiveIntensity: 0.8,
    roughness: 0.4,
  })

  // Chassis, counterweight, cab and overhead guard.
  const bodyGeos = [
    boxAt(0, 0.32, -0.2, 1.05, 0.5, 1.9),
    boxAt(0, 0.55, -1.05, 0.9, 0.55, 0.4),
    boxAt(0, 1.05, -0.55, 0.75, 0.5, 0.6),
    boxAt(0, 1.55, -0.55, 0.8, 0.06, 0.65),
  ]
  // Twin mast rails, a low carriage and the forks resting near the floor.
  const mastGeos = [
    boxAt(-0.38, 1.45, 0.75, 0.09, 2.7, 0.09),
    boxAt(0.38, 1.45, 0.75, 0.09, 2.7, 0.09),
    boxAt(0, 0.28, 0.75, 0.9, 0.12, 0.1),
    boxAt(-0.28, 0.22, 1.55, 0.12, 0.08, 1.5),
    boxAt(0.28, 0.22, 1.55, 0.12, 0.08, 1.5),
  ]
  const wheelGeos = [
    boxAt(-0.5, 0.16, 0.55, 0.18, 0.32, 0.32),
    boxAt(0.5, 0.16, 0.55, 0.18, 0.32, 0.32),
    boxAt(-0.5, 0.16, -0.9, 0.18, 0.32, 0.32),
    boxAt(0.5, 0.16, -0.9, 0.18, 0.32, 0.32),
  ]

  const group = new THREE.Group()
  group.name = 'reachTruck'
  const disposables: (THREE.BufferGeometry | THREE.Material)[] = [bodyMat, mastMat, wheelMat, beaconMat]

  for (const [geos, mat] of [
    [bodyGeos, bodyMat],
    [mastGeos, mastMat],
    [wheelGeos, wheelMat],
  ] as const) {
    const merged = mergeGeometries(geos)
    geos.forEach((g) => g.dispose())
    if (!merged) continue
    const mesh = new THREE.Mesh(merged, mat)
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)
    disposables.push(merged)
  }

  const beaconGeo = new THREE.BoxGeometry(0.14, 0.1, 0.14)
  const beacon = new THREE.Mesh(beaconGeo, beaconMat)
  beacon.position.set(0, 1.63, -0.55)
  group.add(beacon)
  disposables.push(beaconGeo)

  return { group, disposables }
}

/**
 * Diagonal hazard stripe — the standard yellow/black impact-guard paint —
 * baked once into a small tileable canvas rather than modelled as geometry.
 */
function makeHazardTexture(theme: SceneTheme['safety']): THREE.Texture {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = hex(theme.hazardBlack)
  ctx.fillRect(0, 0, size, size)

  ctx.fillStyle = hex(theme.hazardYellow)
  ctx.save()
  ctx.translate(size / 2, size / 2)
  ctx.rotate(Math.PI / 4)
  ctx.translate(-size, -size)
  const stripeW = size / 4
  for (let x = 0; x < size * 4; x += stripeW * 2) {
    ctx.fillRect(x, -size, stripeW, size * 4)
  }
  ctx.restore()

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
