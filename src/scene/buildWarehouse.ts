import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { ThemeMode } from '../ui/theme'
import type { Bin, WarehouseModel } from '../warehouse/types'
import { makeTextSprite } from './labels'
import { buildShell } from './shell'
import { sceneTheme, velocityColors, zoneColors, type SceneTheme } from './theme'

export type BinColorMode = 'velocity' | 'zone'

/** Slab bay size, metres — the pitch of the saw-cut joints in the floor. */
const SLAB_METRES = 6

/**
 * Metres of yard drawn beyond the footprint, in each direction.
 *
 * Generous, and deliberately so: the plan view sits high enough that its frame is
 * far wider than the building, and fog used to hide where the slab stopped. Now
 * that the fog lifts with altitude — so a plan view is crisp, which is the point
 * of one — the slab itself has to reach past the edge of that frame, or the floor
 * ends in a hard rectangle mid-shot. At low camera angles fog still swallows the
 * far end of it.
 */
const YARD_MARGIN = 120

/**
 * Shortest a storage location is ever drawn, as a share of its slot height.
 *
 * The box is the *location*, and its height is how full that location is — so an
 * emptying shelf visibly empties as the wave is picked. It is floored rather than
 * scaled to zero because an empty location is exactly what an inbound putaway is
 * looking for: it still has to be visible, tintable as a candidate, and clickable.
 */
export const MIN_BIN_FILL = 0.45

/**
 * How tall to draw a location, as a share of its slot height: {@link MIN_BIN_FILL}
 * when it is cleared out, 1 when it is at capacity. Over-stocked locations clamp
 * rather than growing through the shelf above.
 */
export function binFill(bin: Bin): number {
  const share = bin.capacity > 0 ? bin.sku.stock / bin.capacity : 0
  return MIN_BIN_FILL + (1 - MIN_BIN_FILL) * Math.min(1, Math.max(0, share))
}

export interface WarehouseVisual {
  group: THREE.Group
  /** Roof steel and lighting, so the scene can drop it for an overhead shot. */
  roof: THREE.Group
  /** Underside of the roof deck, metres. */
  roofHeight: number
  binsMesh: THREE.InstancedMesh
  /** instance index -> bin */
  binOrder: Bin[]
  binIndexById: Map<string, number>
  setColorMode(mode: BinColorMode): void
  /** Temporarily tint a bin (route highlight); pass null to restore. */
  tintBin(binId: string, color: THREE.ColorRepresentation | null): void
  clearTints(): void
  /**
   * Re-read one location from the model: its base colours and how full it is.
   *
   * Both are baked into buffers at build time for speed, so anything that changes
   * a location's stock or its SKU — a line being picked off it, an inbound
   * putaway re-slotting an empty shelf — has to say so explicitly.
   */
  refreshBin(binId: string): void
  /**
   * Re-read how full every location is.
   *
   * For changes that move stock everywhere at once rather than location by
   * location — a shift reset restores the whole facility's opening on-hand — where
   * diffing thousands of locations would cost more than simply rewriting them.
   */
  refreshAllBins(): void
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
  const floorWidth = width + YARD_MARGIN
  const floorDepth = depth + YARD_MARGIN
  const slabTexture = makeSlabTexture(SCENE_THEME)
  slabTexture.repeat.set(floorWidth / SLAB_METRES, floorDepth / SLAB_METRES)
  disposables.push(slabTexture)

  const floorGeo = new THREE.PlaneGeometry(floorWidth, floorDepth)
  const floorMat = new THREE.MeshStandardMaterial({
    color: SCENE_THEME.floor,
    // Power-floated concrete: matte, but not chalk. A little sheen is what lets
    // the high bays and the rack steel read as being in the same room as it.
    roughness: 0.78,
    metalness: 0.04,
    map: slabTexture,
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

  // ── Building shell: walls, roof steel, high bays and floor markings ───────
  const shell = buildShell(model, themeMode)
  group.add(shell.group)

  // ── Racking: uprights + shelf decks, merged into two meshes ───────────────
  const uprightGeos: THREE.BufferGeometry[] = []
  const deckGeos: THREE.BufferGeometry[] = []
  const beamGeos: THREE.BufferGeometry[] = []
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
    const faceX = rack.facing === 1 ? rack.x1 : rack.x0
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
      // Load beam along the aisle-facing edge of every level. Without it the
      // racking reads as floating shelves; with it you can see the structure the
      // stock is actually sitting on from anywhere in the aisle.
      beamGeos.push(
        boxAt(
          faceX - rack.facing * 0.055,
          y + 0.05,
          (rack.z0 + rack.z1) / 2,
          0.11,
          0.14,
          rack.z1 - rack.z0 - 0.05,
        ),
      )
    }
    // Kick rail at floor level, the part a pallet truck actually bumps into.
    beamGeos.push(
      boxAt(faceX - rack.facing * 0.06, 0.09, (rack.z0 + rack.z1) / 2, 0.12, 0.18, rack.z1 - rack.z0 - 0.05),
    )
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
  const beamMat = new THREE.MeshStandardMaterial({
    color: SCENE_THEME.rackBeam,
    roughness: 0.42,
    metalness: 0.72,
  })
  disposables.push(uprightMat, deckMat, beamMat)

  for (const [geos, mat] of [
    [uprightGeos, uprightMat],
    [deckGeos, deckMat],
    [beamGeos, beamMat],
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
  
  // Shrink-wrapped cases on a shelf, not moulded plastic: mostly matte, with
  // just enough clearcoat for the film to catch the high bays.
  const binMat = new THREE.MeshPhysicalMaterial({
    roughness: 0.55,
    metalness: 0.04,
    clearcoat: 0.22,
    clearcoatRoughness: 0.35,
  })

  binMat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>\n varying vec3 vLocalPos;`
    )
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>\n vLocalPos = position;`
    )
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>\n varying vec3 vLocalPos;`
    )
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      // Contact shading: darkest where the stock meets the deck, lifting towards
      // the open front of the slot. Deliberately gentle — the ramp is here to
      // give the bin volume, not to change the colour it is encoding, and under
      // ACES tone mapping a hard multiply flattens every tier to the same
      // over-saturated primary.
      `#include <color_fragment>
       float localHalfHeight = ${(config.levelHeight * 0.25).toFixed(5)};
       float normY = smoothstep(-localHalfHeight, localHalfHeight, vLocalPos.y);
       vec3 gradientBottom = diffuseColor.rgb * 0.52;
       vec3 gradientTop = diffuseColor.rgb * 1.12;
       diffuseColor.rgb = mix(gradientBottom, gradientTop, normY);`
    )
  }

  disposables.push(binGeo, binMat)

  const binOrder = model.bins
  const binsMesh = new THREE.InstancedMesh(binGeo, binMat, binOrder.length)
  binsMesh.name = 'bins'
  binsMesh.castShadow = false
  binsMesh.receiveShadow = true
  // Locations now change height as they are picked and put away, so the matrix
  // buffer is genuinely dynamic — a handful of writes a second, not a rebuild.
  binsMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)

  const matrix = new THREE.Matrix4()
  const binPos = new THREE.Vector3()
  const binScale = new THREE.Vector3(1, 1, 1)
  const noRotation = new THREE.Quaternion()
  const binHeight = config.levelHeight * 0.5
  const binIndexById = new Map<string, number>()

  /**
   * Place one location's box: scaled to its fill and sitting on its shelf deck,
   * so stock comes off the top of the pile rather than shrinking about its middle.
   */
  const writeBinMatrix = (bin: Bin, index: number) => {
    const facing = bin.side === 'L' ? 1 : -1
    const fill = binFill(bin)
    const deck = bin.face.y - binHeight / 2
    binPos.set(bin.face.x - facing * (binDepth / 2 - 0.02), deck + (binHeight * fill) / 2, bin.face.z)
    binScale.set(1, fill, 1)
    matrix.compose(binPos, noRotation, binScale)
    binsMesh.setMatrixAt(index, matrix)
  }

  binOrder.forEach((bin, i) => {
    writeBinMatrix(bin, i)
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

  const writePalette = (target: Float32Array, index: number, hex: number) => {
    baseColor.setHex(hex)
    target[index * 3] = baseColor.r
    target[index * 3 + 1] = baseColor.g
    target[index * 3 + 2] = baseColor.b
  }

  const visual: WarehouseVisual = {
    group,
    roof: shell.roof,
    roofHeight: shell.roofHeight,
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
    refreshAllBins() {
      binOrder.forEach(writeBinMatrix)
      binsMesh.instanceMatrix.needsUpdate = true
    },
    refreshBin(binId) {
      const index = binIndexById.get(binId)
      if (index === undefined) return
      const bin = binOrder[index]

      writeBinMatrix(bin, index)
      binsMesh.instanceMatrix.needsUpdate = true

      writePalette(palettes.velocity, index, VELOCITY_COLOR[bin.sku.velocity])
      writePalette(palettes.zone, index, ZONE_COLORS[bin.aisle % ZONE_COLORS.length])
      // A tinted bin keeps its tint; the new base shows through once it clears.
      if (!tinted.has(index)) {
        restore(index)
        instanceColor.needsUpdate = true
      }
    },
    dispose() {
      binsMesh.dispose()
      shell.dispose()
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
  // Rubber for the dock bumpers and door seals, plus the pallet kit standing in
  // the staging lanes. One material each, shared across every instance.
  const P = SCENE_THEME.props
  const rubberMat = new THREE.MeshStandardMaterial({ color: P.rubber, roughness: 0.95 })
  const palletMat = new THREE.MeshStandardMaterial({ color: P.pallet, roughness: 0.92 })
  const cartonMat = new THREE.MeshStandardMaterial({ color: P.carton, roughness: 0.88 })
  const wrapMat = new THREE.MeshStandardMaterial({
    color: P.wrap,
    roughness: 0.35,
    transparent: true,
    opacity: P.wrapOpacity,
    depthWrite: false,
  })
  disposables.push(structureMat, doorMat, packTopMat, rubberMat, palletMat, cartonMat, wrapMat)

  /*
   * Scenery is collected as geometry and merged once, not added as meshes.
   *
   * Drawn individually, four dock doors and two staging lanes are ~240 extra draw
   * calls — more than the rest of the building put together, for objects that
   * never move. Merged by material it is five.
   */
  const rubberGeos: THREE.BufferGeometry[] = []
  const levellerGeos: THREE.BufferGeometry[] = []
  const palletGeos: THREE.BufferGeometry[] = []
  const cartonGeos: THREE.BufferGeometry[] = []
  const wrapGeos: THREE.BufferGeometry[] = []

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

      // Slats: a sectional door is a stack of panels, and the shadow lines
      // between them are most of what makes it read as a door at all.
      for (let s = 1; s <= 7; s++) {
        rubberGeos.push(boxAt(f.pos.x, 0.1 + (3.6 / 8) * s, f.pos.y + 0.03, f.width - 0.06, 0.05, 0.06))
      }

      // Bumpers either side at trailer-bed height, and the leveller plate the
      // pallet truck actually drives over.
      for (const dx of [-1, 1]) {
        rubberGeos.push(boxAt(f.pos.x + dx * (f.width / 2 + 0.16), 1.05, f.pos.y + 0.1, 0.22, 0.5, 0.3))
      }
      levellerGeos.push(boxAt(f.pos.x, 0.05, f.pos.y + 0.95, f.width - 0.2, 0.06, 1.6))

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

      /*
       * Wrapped pallets standing in the lane.
       *
       * Staging lanes are where stock waits, and an empty painted rectangle
       * labelled "Outbound Staging" is the emptiest-looking part of a warehouse.
       * They are parked along the two long edges so the middle stays clear —
       * pickers return to the node at the centre of this footprint, and a picker
       * walking through a pallet would undo the point of drawing one.
       *
       * Count and stack height come off the facility's own index, so the same
       * layout always stages the same pallets.
       */
      const seed = model.facilities.indexOf(f)
      const lanes = Math.max(2, Math.floor((f.width - 0.6) / 1.45))
      for (let i = 0; i < lanes; i++) {
        for (const side of [-1, 1] as const) {
          // One gap per row, so the rows are not suspiciously uniform.
          if ((i + (side > 0 ? 1 : 0) + seed) % 4 === 0) continue

          const x = f.pos.x - f.width / 2 + 0.75 + i * ((f.width - 1.5) / Math.max(1, lanes - 1))
          const z = f.pos.y + side * (f.depth / 2 - 0.65)
          const courses = 2 + ((i + seed + (side > 0 ? 1 : 0)) % 3)

          palletGeos.push(boxAt(x, 0.07, z, 1.2, 0.14, 1.0))

          for (let c = 0; c < courses; c++) {
            for (const [dx, dz] of [
              [-0.28, -0.24],
              [0.28, -0.24],
              [-0.28, 0.24],
              [0.28, 0.24],
            ] as const) {
              cartonGeos.push(boxAt(x + dx, 0.31 + c * 0.34, z + dz, 0.52, 0.34, 0.44))
            }
          }

          // Stretch film over the whole load, sized to the courses under it.
          const wrapHeight = courses * 0.34 + 0.06
          wrapGeos.push(boxAt(x, 0.14 + wrapHeight / 2, z, 1.1, wrapHeight, 0.94))
        }
      }

      const label = makeTextSprite(f.label, {
        fontSize: 44,
        worldHeight: 0.66,
        ...SCENE_THEME.staging,
      })
      label.position.set(f.pos.x, 1.4, f.pos.y)
      group.add(label)
    }
  }

  // One mesh per scenery material. Shadows are cast by the things with real bulk
  // (pallet loads, bumpers) and only received by the flat plate on the floor.
  for (const [geos, mat, cast, receive] of [
    [rubberGeos, rubberMat, true, false],
    [levellerGeos, structureMat, false, true],
    [palletGeos, palletMat, true, false],
    [cartonGeos, cartonMat, true, false],
    [wrapGeos, wrapMat, false, false],
  ] as const) {
    const merged = mergeGeometries(geos)
    geos.forEach((g) => g.dispose())
    if (!merged) continue
    const mesh = new THREE.Mesh(merged, mat)
    mesh.castShadow = cast
    mesh.receiveShadow = receive
    group.add(mesh)
    disposables.push(merged)
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

/**
 * One concrete slab bay, tiled across the floor.
 *
 * Three things in one texture, because they are three real features of a
 * power-floated warehouse slab and each does a different job:
 *
 *   the saw-cut joint at the bay edge — a 6 m grid of them is the strongest cue
 *   that this is a poured floor rather than a shaded plane;
 *   a faint 1 m grid inside it, which is what gives the viewer scale;
 *   and a fine aggregate speckle, which stops the floor reading as flat paint
 *   under the near-specular sheen the material now has.
 *
 * The speckle comes off a fixed-seed LCG rather than `Math.random`, so the same
 * layout always produces the same floor — a texture that reshuffles on every
 * theme swap would be visible as a flicker.
 */
function makeSlabTexture(theme: SceneTheme): THREE.Texture {
  const size = 512
  /** Texels per metre, from the tile being {@link SLAB_METRES} across. */
  const perMetre = size / SLAB_METRES
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!

  // The map multiplies the material colour, so white is "leave the concrete be".
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, size, size)

  let seed = 0x9e3779b9
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 0xffffffff
  }

  ctx.fillStyle = theme.floorSpeckle
  for (let i = 0; i < 2600; i++) {
    const r = 0.4 + rand() * 1.5
    ctx.beginPath()
    ctx.arc(rand() * size, rand() * size, r, 0, Math.PI * 2)
    ctx.fill()
  }

  // Broad trowel mottling, so the slab is not uniformly speckled either. The
  // outer stop fades the speckle's own colour out rather than fading to white,
  // which canvas would interpolate through as a visible pale halo.
  const transparent = theme.floorSpeckle.replace(/,\s*[\d.]+\)$/, ',0)')
  for (let i = 0; i < 14; i++) {
    const x = rand() * size
    const y = rand() * size
    const r = size * (0.08 + rand() * 0.16)
    const shade = ctx.createRadialGradient(x, y, 0, x, y, r)
    shade.addColorStop(0, theme.floorSpeckle)
    shade.addColorStop(1, transparent)
    ctx.fillStyle = shade
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.strokeStyle = theme.floorGrid
  ctx.lineWidth = 1
  for (let m = 1; m < SLAB_METRES; m++) {
    const p = Math.round(m * perMetre) + 0.5
    ctx.beginPath()
    ctx.moveTo(p, 0)
    ctx.lineTo(p, size)
    ctx.moveTo(0, p)
    ctx.lineTo(size, p)
    ctx.stroke()
  }

  // Saw-cut joint on two edges only: the neighbouring tile draws the other two,
  // so a shared cut is one line wide instead of two.
  ctx.strokeStyle = theme.floorJoint
  ctx.lineWidth = 2.5
  ctx.beginPath()
  ctx.moveTo(1.25, 0)
  ctx.lineTo(1.25, size)
  ctx.moveTo(0, 1.25)
  ctx.lineTo(size, 1.25)
  ctx.stroke()

  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.colorSpace = THREE.SRGBColorSpace
  // Generous, because from the plan view the floor is seen at a hard grazing
  // angle at the edges of the frame. Three clamps this to the device maximum.
  texture.anisotropy = 8
  return texture
}
