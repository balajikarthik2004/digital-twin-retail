import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { ThemeMode } from '../ui/theme'
import type { Bin, WarehouseModel } from '../warehouse/types'
import { makeTextSprite } from './labels'
import { sceneTheme, velocityColors, zoneColors } from './theme'

export type BinColorMode = 'velocity' | 'zone'

export interface WarehouseVisual {
  group: THREE.Group
  binsMesh: THREE.InstancedMesh
  /** instance index -> bin */
  binOrder: Bin[]
  binIndexById: Map<string, number>
  setColorMode(mode: BinColorMode): void
  /** Temporarily tint a bin (route highlight); pass null to restore. */
  tintBin(binId: string, color: THREE.ColorRepresentation | null): void
  clearTints(): void
  dispose(): void
}

/**
 * Build all static warehouse geometry from the model.
 *
 * Everything here is derived from `WarehouseModel` — there are no hardcoded
 * object positions, so a different layout config produces a different (but
 * equally complete) building.
 */
export function buildWarehouse(model: WarehouseModel, themeMode: ThemeMode = 'light'): WarehouseVisual {
  const { config, bounds } = model
  const SCENE_THEME = sceneTheme(themeMode)
  const VELOCITY_COLOR = velocityColors(themeMode)
  const ZONE_COLORS = zoneColors(themeMode)
  const group = new THREE.Group()
  group.name = 'warehouse'
  const disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = []

  const width = bounds.maxX - bounds.minX
  const depth = bounds.maxZ - bounds.minZ
  const centerX = (bounds.minX + bounds.maxX) / 2
  const centerZ = (bounds.minZ + bounds.maxZ) / 2

  // ── Floor ─────────────────────────────────────────────────────────────────
  const gridTexture = makeGridTexture(SCENE_THEME.floorGrid)
  gridTexture.repeat.set(width, depth)
  disposables.push(gridTexture)

  const floorGeo = new THREE.PlaneGeometry(width + 24, depth + 24)
  const floorMat = new THREE.MeshStandardMaterial({
    color: SCENE_THEME.floor,
    roughness: 0.92,
    metalness: 0.05,
    map: gridTexture,
  })
  const floor = new THREE.Mesh(floorGeo, floorMat)
  floor.rotation.x = -Math.PI / 2
  floor.position.set(centerX, 0, centerZ)
  floor.receiveShadow = true
  group.add(floor)
  disposables.push(floorGeo, floorMat)

  // ── Painted lanes: picking aisles + cross aisles + apron ──────────────────
  const laneMat = new THREE.MeshStandardMaterial({
    color: SCENE_THEME.aisleLane,
    roughness: 0.8,
    transparent: true,
    opacity: 0.95,
  })
  disposables.push(laneMat)
  const laneGeos: THREE.BufferGeometry[] = []

  const storageMinZ = model.crossZ[0] - config.crossAisleWidth / 2
  const storageMaxZ = model.crossZ[model.crossZ.length - 1] + config.crossAisleWidth / 2

  for (const x of model.aisleX) {
    laneGeos.push(planeAt(x, centerZOf(storageMinZ, storageMaxZ), config.aisleWidth, storageMaxZ - storageMinZ))
  }
  for (const z of model.crossZ) {
    laneGeos.push(planeAt(centerX, z, width, config.crossAisleWidth))
  }
  laneGeos.push(planeAt(centerX, storageMinZ - config.apronDepth * 0.5, width, config.apronDepth * 0.34))

  const laneMerged = mergeGeometries(laneGeos)
  laneGeos.forEach((g) => g.dispose())
  if (laneMerged) {
    const lanes = new THREE.Mesh(laneMerged, laneMat)
    lanes.position.y = 0.012
    lanes.receiveShadow = false
    group.add(lanes)
    disposables.push(laneMerged)
  }

  // ── Racking: uprights + shelf decks, merged into two meshes ───────────────
  const uprightGeos: THREE.BufferGeometry[] = []
  const deckGeos: THREE.BufferGeometry[] = []
  const rackHeight = 0.16 + config.levels * config.levelHeight
  const postSize = 0.1

  for (const rack of model.racks) {
    const runDepth = rack.x1 - rack.x0
    const bays = Math.round((rack.z1 - rack.z0) / config.bayWidth)

    for (let i = 0; i <= bays; i++) {
      const z = rack.z0 + i * config.bayWidth
      for (const x of [rack.x0 + postSize / 2, rack.x1 - postSize / 2]) {
        uprightGeos.push(boxAt(x, rackHeight / 2, z, postSize, rackHeight, postSize))
      }
    }
    // A deck under each level — deliberately none above the top level, so the
    // plan view looks straight down into the storage locations.
    for (let level = 0; level < config.levels; level++) {
      const y = 0.16 + level * config.levelHeight
      deckGeos.push(
        boxAt(
          (rack.x0 + rack.x1) / 2,
          y,
          (rack.z0 + rack.z1) / 2,
          runDepth * 0.94,
          0.045,
          rack.z1 - rack.z0 - 0.05,
        ),
      )
    }
    // Thin back panel so racks read as solid from the far aisle.
    deckGeos.push(
      boxAt(
        rack.facing === 1 ? rack.x0 + 0.02 : rack.x1 - 0.02,
        rackHeight / 2,
        (rack.z0 + rack.z1) / 2,
        0.04,
        rackHeight * 0.96,
        rack.z1 - rack.z0 - 0.05,
      ),
    )
  }

  const uprightMat = new THREE.MeshStandardMaterial({
    color: SCENE_THEME.rackUpright,
    roughness: 0.45,
    metalness: 0.55,
  })
  const deckMat = new THREE.MeshStandardMaterial({
    color: SCENE_THEME.rackDeck,
    roughness: 0.75,
    metalness: 0.2,
  })
  disposables.push(uprightMat, deckMat)

  for (const [geos, mat] of [
    [uprightGeos, uprightMat],
    [deckGeos, deckMat],
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

  // ── Bins: one InstancedMesh for every storage location ────────────────────
  const slotWidth = config.bayWidth / config.slotsPerBay
  const binDepth = config.rackDepth * 0.7
  // Gaps on all sides so individual slots stay readable at aisle level rather
  // than merging into one coloured slab.
  const binGeo = new THREE.BoxGeometry(binDepth, config.levelHeight * 0.5, slotWidth * 0.78)
  const binMat = new THREE.MeshStandardMaterial({ roughness: 0.68, metalness: 0.06 })
  disposables.push(binGeo, binMat)

  const binOrder = model.bins
  const binsMesh = new THREE.InstancedMesh(binGeo, binMat, binOrder.length)
  binsMesh.name = 'bins'
  binsMesh.castShadow = false
  binsMesh.receiveShadow = true
  binsMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)

  const matrix = new THREE.Matrix4()
  const binIndexById = new Map<string, number>()
  binOrder.forEach((bin, i) => {
    const facing = bin.side === 'L' ? 1 : -1
    matrix.makeTranslation(bin.face.x - facing * (binDepth / 2 - 0.02), bin.face.y, bin.face.z)
    binsMesh.setMatrixAt(i, matrix)
    binIndexById.set(bin.id, i)
  })
  binsMesh.instanceMatrix.needsUpdate = true

  // Base colours per mode, kept so tints can be reverted exactly.
  // `Color.setHex` already converts sRGB into the renderer's working (linear)
  // space, which is exactly what `instanceColor` expects — converting again
  // here would crush every bin into an over-saturated primary.
  const baseColor = new THREE.Color()
  const palettes: Record<BinColorMode, Float32Array> = {
    velocity: new Float32Array(binOrder.length * 3),
    zone: new Float32Array(binOrder.length * 3),
  }
  binOrder.forEach((bin, i) => {
    baseColor.setHex(VELOCITY_COLOR[bin.sku.velocity])
    palettes.velocity[i * 3] = baseColor.r
    palettes.velocity[i * 3 + 1] = baseColor.g
    palettes.velocity[i * 3 + 2] = baseColor.b
    baseColor.setHex(ZONE_COLORS[bin.aisle % ZONE_COLORS.length])
    palettes.zone[i * 3] = baseColor.r
    palettes.zone[i * 3 + 1] = baseColor.g
    palettes.zone[i * 3 + 2] = baseColor.b
  })

  let mode: BinColorMode = 'velocity'
  const instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(palettes.velocity), 3)
  instanceColor.setUsage(THREE.DynamicDrawUsage)
  binsMesh.instanceColor = instanceColor
  const tinted = new Set<number>()

  const restore = (index: number) => {
    const src = palettes[mode]
    const arr = instanceColor.array as Float32Array
    arr[index * 3] = src[index * 3]
    arr[index * 3 + 1] = src[index * 3 + 1]
    arr[index * 3 + 2] = src[index * 3 + 2]
  }

  const visual: WarehouseVisual = {
    group,
    binsMesh,
    binOrder,
    binIndexById,
    setColorMode(next) {
      mode = next
      const arr = instanceColor.array as Float32Array
      arr.set(palettes[next])
      tinted.clear()
      instanceColor.needsUpdate = true
    },
    tintBin(binId, color) {
      const index = binIndexById.get(binId)
      if (index === undefined) return
      if (color === null) {
        restore(index)
        tinted.delete(index)
      } else {
        const c = new THREE.Color(color)
        const arr = instanceColor.array as Float32Array
        arr[index * 3] = c.r
        arr[index * 3 + 1] = c.g
        arr[index * 3 + 2] = c.b
        tinted.add(index)
      }
      instanceColor.needsUpdate = true
    },
    clearTints() {
      if (tinted.size === 0) return
      for (const index of tinted) restore(index)
      tinted.clear()
      instanceColor.needsUpdate = true
    },
    dispose() {
      binsMesh.dispose()
      for (const d of disposables) d.dispose()
      group.traverse((obj) => {
        if (obj instanceof THREE.Sprite) {
          const mat = obj.material as THREE.SpriteMaterial
          mat.map?.dispose()
          mat.dispose()
        }
      })
    },
  }

  group.add(binsMesh)

  // ── Docks, pack stations, staging ─────────────────────────────────────────
  const structureMat = new THREE.MeshStandardMaterial({ color: SCENE_THEME.dock, roughness: 0.6, metalness: 0.25 })
  const doorMat = new THREE.MeshStandardMaterial({
    color: SCENE_THEME.dockDoor,
    roughness: 0.5,
    metalness: 0.3,
    emissive: new THREE.Color(SCENE_THEME.dockDoor).multiplyScalar(0.25),
  })
  const packTopMat = new THREE.MeshStandardMaterial({
    color: SCENE_THEME.packTop,
    roughness: 0.5,
    emissive: new THREE.Color(SCENE_THEME.packTop).multiplyScalar(0.22),
  })
  disposables.push(structureMat, doorMat, packTopMat)

  for (const f of model.facilities) {
    if (f.kind === 'dock') {
      const frameGeo = new THREE.BoxGeometry(f.width + 0.5, 4.2, 0.5)
      const frame = new THREE.Mesh(frameGeo, structureMat)
      frame.position.set(f.pos.x, 2.1, f.pos.y - 0.3)
      const doorGeo = new THREE.BoxGeometry(f.width, 3.6, 0.12)
      const door = new THREE.Mesh(doorGeo, doorMat)
      door.position.set(f.pos.x, 1.85, f.pos.y - 0.05)
      group.add(frame, door)
      disposables.push(frameGeo, doorGeo)

      const label = makeTextSprite(f.label, { fontSize: 46, worldHeight: 0.72, ...SCENE_THEME.label })
      label.position.set(f.pos.x, 4.7, f.pos.y)
      group.add(label)
    } else if (f.kind === 'pack') {
      const benchGeo = new THREE.BoxGeometry(f.width, 0.9, f.depth)
      const bench = new THREE.Mesh(benchGeo, structureMat)
      bench.position.set(f.pos.x, 0.45, f.pos.y)
      bench.castShadow = true
      const topGeo = new THREE.BoxGeometry(f.width + 0.12, 0.08, f.depth + 0.12)
      const top = new THREE.Mesh(topGeo, packTopMat)
      top.position.set(f.pos.x, 0.94, f.pos.y)
      group.add(bench, top)
      disposables.push(benchGeo, topGeo)

      const label = makeTextSprite(f.label, { fontSize: 44, worldHeight: 0.62, ...SCENE_THEME.label })
      label.position.set(f.pos.x, 1.9, f.pos.y)
      group.add(label)
    } else {
      const outline = new THREE.Mesh(
        planeAt(f.pos.x, f.pos.y, f.width, f.depth),
        new THREE.MeshBasicMaterial({
          color: SCENE_THEME.stagingEdge,
          transparent: true,
          opacity: 0.1,
          side: THREE.DoubleSide,
        }),
      )
      outline.position.y = 0.02
      group.add(outline)
      disposables.push(outline.geometry, outline.material as THREE.Material)

      const label = makeTextSprite(f.label, {
        fontSize: 44,
        worldHeight: 0.66,
        ...SCENE_THEME.staging,
      })
      label.position.set(f.pos.x, 1.4, f.pos.y)
      group.add(label)
    }
  }

  // ── Aisle identifiers at both ends of every aisle ─────────────────────────
  model.aisleX.forEach((x, a) => {
    const text = `A${String(a + 1).padStart(2, '0')}`
    for (const z of [storageMinZ - 0.6, storageMaxZ + 0.6]) {
      const sprite = makeTextSprite(text, {
        fontSize: 52,
        worldHeight: 0.78,
        ...SCENE_THEME.aisleLabel,
      })
      sprite.position.set(x, 0.95, z)
      group.add(sprite)
    }
  })

  // ── Perimeter curb ────────────────────────────────────────────────────────
  const curbMat = new THREE.MeshStandardMaterial({ color: SCENE_THEME.curb, roughness: 0.9 })
  disposables.push(curbMat)
  const curbGeos = [
    boxAt(centerX, 0.18, bounds.minZ - 0.3, width + 4, 0.36, 0.4),
    boxAt(centerX, 0.18, bounds.maxZ + 0.3, width + 4, 0.36, 0.4),
    boxAt(bounds.minX - 0.3, 0.18, centerZ, 0.4, 0.36, depth + 4),
    boxAt(bounds.maxX + 0.3, 0.18, centerZ, 0.4, 0.36, depth + 4),
  ]
  const curbMerged = mergeGeometries(curbGeos)
  curbGeos.forEach((g) => g.dispose())
  if (curbMerged) {
    group.add(new THREE.Mesh(curbMerged, curbMat))
    disposables.push(curbMerged)
  }

  return visual
}

function centerZOf(a: number, b: number) {
  return (a + b) / 2
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

/** 1 m² faint grid, tiled across the floor to give a sense of scale. */
function makeGridTexture(lineColor: string): THREE.Texture {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, size, size)
  ctx.strokeStyle = lineColor
  ctx.lineWidth = 2
  ctx.strokeRect(0, 0, size, size)

  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return texture
}
