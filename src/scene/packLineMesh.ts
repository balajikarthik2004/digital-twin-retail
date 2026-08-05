import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { PackStation, Parcel } from '../simulation/types'
import type { ConveyorRun, Vec3 } from '../warehouse/conveyor'
import type { WarehouseModel } from '../warehouse/types'
import type { ThemeMode } from '../ui/theme'
import { disposeSprite, makeTextSprite } from './labels'
import { channelColors, sceneTheme } from './theme'

/**
 * The pack-out and dispatch half of the building, in 3D.
 *
 * Everything here is driven from the same `ConveyorNetwork` the simulation moves
 * parcels along, so what you see is literally where the engine thinks each
 * parcel is — not a decorative belt running beside the numbers. Belt motion is
 * driven by the live line speed, benches carry an andon beacon reading the
 * station's real state, and parcels are one instanced mesh so a busy sorter
 * costs one draw call.
 */

/** Metres of belt covered by one tile of the cleat texture. */
const BELT_TILE = 0.9
/** Parcel instance ceiling — far above what a saturated sorter holds. */
const MAX_PARCELS = 320
/** Lift a carton off the belt centreline so it sits ON the belt, not in it. */
const PARCEL_LIFT = 0.19

const UP = new THREE.Vector3(0, 1, 0)

export interface PackLineVisual {
  group: THREE.Group
  /** Instanced cartons — also the raycast target for parcel picking. */
  parcelsMesh: THREE.InstancedMesh
  /** Scroll every belt at the live line speed. */
  tick(dt: number, speed: number): void
  syncParcels(parcels: Parcel[], visible: boolean): void
  syncStations(stations: PackStation[], dt: number): void
  parcelIdAt(instanceId: number): string | null
  parcelPosition(id: string): THREE.Vector3 | null
  dispose(): void
}

interface StationVisual {
  group: THREE.Group
  beacon: THREE.Mesh
  beaconMat: THREE.MeshStandardMaterial
  arms: THREE.Object3D[]
  carton: THREE.Mesh
  phase: number
}

export function buildPackLine(model: WarehouseModel, themeMode: ThemeMode): PackLineVisual {
  const theme = sceneTheme(themeMode)
  const CHANNEL = channelColors(themeMode)
  const net = model.conveyor
  const group = new THREE.Group()
  group.name = 'packLine'

  const disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = []
  const sprites: THREE.Sprite[] = []
  const beltTextures: THREE.Texture[] = []

  // ── Belts ─────────────────────────────────────────────────────────────────
  const beltBase = makeBeltTexture(theme.conveyor.belt, theme.conveyor.cleat)
  disposables.push(beltBase)

  const addRun = (run: ConveyorRun, width: number, powered: boolean) => {
    for (let i = 1; i < run.polyline.length; i++) {
      const belt = makeBeltMesh(run.polyline[i - 1], run.polyline[i], width, beltBase, powered)
      if (!belt) continue
      group.add(belt.mesh)
      disposables.push(belt.mesh.geometry, belt.mesh.material as THREE.Material)
      if (powered) beltTextures.push(belt.texture)
      else disposables.push(belt.texture)
    }
  }

  addRun(net.trunk, net.beltWidth, true)
  for (const spur of net.spurs) addRun(spur, net.beltWidth * 0.92, true)
  for (const chute of net.chutes) addRun(chute, net.beltWidth * 0.98, false)

  // ── Frame: side rails under every run, plus the support legs ───────────────
  const railGeos: THREE.BufferGeometry[] = []
  const pushRails = (run: ConveyorRun, width: number) => {
    for (let i = 1; i < run.polyline.length; i++) {
      const a = run.polyline[i - 1]
      const b = run.polyline[i]
      const frame = orient(a, b)
      if (!frame) continue
      for (const side of [-1, 1]) {
        const geo = new THREE.BoxGeometry(0.055, frame.length, 0.14)
        geo.applyMatrix4(frame.matrix.clone().multiply(offset((width / 2 + 0.04) * side, -0.06)))
        railGeos.push(geo)
      }
      // Under-beam, so the run reads as a structure rather than a floating strip.
      const beam = new THREE.BoxGeometry(width * 0.7, frame.length, 0.07)
      beam.applyMatrix4(frame.matrix.clone().multiply(offset(0, -0.15)))
      railGeos.push(beam)
    }
  }
  pushRails(net.trunk, net.beltWidth)
  for (const spur of net.spurs) pushRails(spur, net.beltWidth * 0.92)
  for (const chute of net.chutes) pushRails(chute, net.beltWidth * 0.98)

  const frameMat = new THREE.MeshStandardMaterial({
    color: theme.conveyor.frame,
    roughness: 0.42,
    metalness: 0.62,
  })
  disposables.push(frameMat)
  const railMerged = mergeGeometries(railGeos)
  railGeos.forEach((g) => g.dispose())
  if (railMerged) {
    const rails = new THREE.Mesh(railMerged, frameMat)
    rails.castShadow = true
    group.add(rails)
    disposables.push(railMerged)
  }

  const legGeos = net.legs.map((leg) => {
    const geo = new THREE.BoxGeometry(0.12, leg.height, 0.12)
    geo.translate(leg.x, leg.height / 2 - 0.1, leg.z)
    return geo
  })
  const legMat = new THREE.MeshStandardMaterial({
    color: theme.conveyor.leg,
    roughness: 0.5,
    metalness: 0.5,
  })
  disposables.push(legMat)
  const legMerged = mergeGeometries(legGeos)
  legGeos.forEach((g) => g.dispose())
  if (legMerged) {
    const legs = new THREE.Mesh(legMerged, legMat)
    legs.castShadow = true
    group.add(legs)
    disposables.push(legMerged)
  }

  // ── Labels: the two conveyor legs, and a divert sign over each chute ───────
  for (const label of net.labels) {
    const sprite = makeTextSprite(label.text, { fontSize: 40, worldHeight: 0.6, ...theme.label })
    sprite.position.set(label.pos.x, label.pos.y, label.pos.z)
    group.add(sprite)
    sprites.push(sprite)
  }
  for (const chute of net.chutes) {
    const head = chute.polyline[0]
    const sprite = makeTextSprite(`→ ${chute.label}`, {
      fontSize: 34,
      worldHeight: 0.44,
      ...theme.staging,
    })
    sprite.position.set(head.x, head.y + 0.62, head.z)
    group.add(sprite)
    sprites.push(sprite)

    // Outbound staging pad the parcels stack on.
    const padGeo = new THREE.PlaneGeometry(2.1, 1.7)
    padGeo.rotateX(-Math.PI / 2)
    const padMat = new THREE.MeshBasicMaterial({
      color: theme.stagingEdge,
      transparent: true,
      opacity: 0.14,
      side: THREE.DoubleSide,
    })
    const pad = new THREE.Mesh(padGeo, padMat)
    pad.position.set(chute.stagePos.x, 0.025, chute.stagePos.z)
    group.add(pad)
    disposables.push(padGeo, padMat)
  }

  // ── Pack benches: packer, work-in-progress carton, andon beacon ────────────
  const packerMat = new THREE.MeshStandardMaterial({
    color: theme.pack.packer,
    roughness: 0.5,
    emissive: new THREE.Color(theme.pack.packer).multiplyScalar(0.22),
  })
  const skinMat = new THREE.MeshStandardMaterial({ color: 0x9d7658, roughness: 0.75 })
  const cartonMat = new THREE.MeshStandardMaterial({ color: theme.parcel.carton, roughness: 0.9 })
  const screenMat = new THREE.MeshStandardMaterial({
    color: 0x0d1b26,
    emissive: new THREE.Color(0x1f8a99),
    emissiveIntensity: 0.7,
    roughness: 0.35,
  })
  disposables.push(packerMat, skinMat, cartonMat, screenMat)

  const GEO = {
    torso: new THREE.CapsuleGeometry(0.2, 0.4, 6, 12),
    head: new THREE.SphereGeometry(0.14, 14, 10),
    arm: new THREE.CapsuleGeometry(0.05, 0.3, 4, 8),
    carton: new THREE.BoxGeometry(0.4, 0.28, 0.32),
    beacon: new THREE.SphereGeometry(0.11, 12, 10),
    mast: new THREE.CylinderGeometry(0.026, 0.026, 0.95, 8),
    screen: new THREE.BoxGeometry(0.42, 0.3, 0.04),
  }
  for (const geo of Object.values(GEO)) disposables.push(geo)

  const packFacilities = model.facilities.filter((f) => f.kind === 'pack')
  const stationVisuals: StationVisual[] = packFacilities.map((facility) => {
    const stationGroup = new THREE.Group()
    // The packer stands on the aisle side of the bench, facing the belt.
    const standZ = facility.pos.y + facility.depth / 2 + 0.55
    stationGroup.position.set(facility.pos.x, 0, standZ)

    const torso = new THREE.Mesh(GEO.torso, packerMat)
    torso.position.y = 1.12
    torso.castShadow = true
    const head = new THREE.Mesh(GEO.head, skinMat)
    head.position.y = 1.48
    head.castShadow = true

    const arms: THREE.Object3D[] = []
    for (const dx of [-0.25, 0.25]) {
      const shoulder = new THREE.Group()
      shoulder.position.set(dx, 1.34, 0)
      const arm = new THREE.Mesh(GEO.arm, packerMat)
      arm.position.y = -0.2
      shoulder.add(arm)
      shoulder.rotation.x = -0.5
      stationGroup.add(shoulder)
      arms.push(shoulder)
    }
    stationGroup.add(torso, head)

    // Work-in-progress carton on the bench top, shown only while packing.
    const carton = new THREE.Mesh(GEO.carton, cartonMat)
    carton.position.set(0, 1.12, -0.75)
    carton.castShadow = true
    carton.visible = false
    stationGroup.add(carton)

    const screen = new THREE.Mesh(GEO.screen, screenMat)
    screen.position.set(0.85, 1.28, -0.7)
    screen.rotation.y = -0.5
    stationGroup.add(screen)

    const mast = new THREE.Mesh(GEO.mast, legMat)
    mast.position.set(-1.15, 1.4, -0.7)
    stationGroup.add(mast)

    const beaconMat = new THREE.MeshStandardMaterial({
      color: theme.pack.beaconIdle,
      emissive: new THREE.Color(theme.pack.beaconIdle),
      emissiveIntensity: 0.9,
      roughness: 0.3,
    })
    const beacon = new THREE.Mesh(GEO.beacon, beaconMat)
    beacon.position.set(-1.15, 1.95, -0.7)
    stationGroup.add(beacon)
    disposables.push(beaconMat)

    group.add(stationGroup)
    return { group: stationGroup, beacon, beaconMat, arms, carton, phase: 0 }
  })

  // ── Parcels: one instanced carton mesh + one instanced shipping label ──────
  const parcelGeo = new THREE.BoxGeometry(0.44, 0.3, 0.36)
  const parcelMat = new THREE.MeshStandardMaterial({ roughness: 0.88, metalness: 0.02 })
  const parcelsMesh = new THREE.InstancedMesh(parcelGeo, parcelMat, MAX_PARCELS)
  parcelsMesh.name = 'parcels'
  parcelsMesh.castShadow = true
  parcelsMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  parcelsMesh.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(MAX_PARCELS * 3),
    3,
  )
  parcelsMesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
  parcelsMesh.count = 0
  parcelsMesh.frustumCulled = false

  const labelGeo = new THREE.PlaneGeometry(0.2, 0.14)
  labelGeo.rotateX(-Math.PI / 2)
  const labelMat = new THREE.MeshStandardMaterial({ roughness: 0.6 })
  const labelsMesh = new THREE.InstancedMesh(labelGeo, labelMat, MAX_PARCELS)
  labelsMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  labelsMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARCELS * 3), 3)
  labelsMesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
  labelsMesh.count = 0
  labelsMesh.frustumCulled = false

  group.add(parcelsMesh, labelsMesh)
  disposables.push(parcelGeo, parcelMat, labelGeo, labelMat)

  const parcelIds: string[] = []
  /** Live parcel lookup, so the inspector can follow one down the belt. */
  const parcelById = new Map<string, Parcel>()
  const matrix = new THREE.Matrix4()
  const quat = new THREE.Quaternion()
  const scaleVec = new THREE.Vector3()
  const posVec = new THREE.Vector3()
  const tint = new THREE.Color()
  const channelTint = new THREE.Color()
  const cartonColor = new THREE.Color(theme.parcel.carton)
  const tapeColor = new THREE.Color(theme.parcel.tape)

  return {
    group,
    parcelsMesh,

    tick(dt, speed) {
      const shift = (speed * dt) / BELT_TILE
      for (const texture of beltTextures) {
        texture.offset.y -= shift
        if (texture.offset.y < -1e4) texture.offset.y = 0
      }
    },

    syncParcels(parcels, visible) {
      parcelsMesh.visible = visible
      labelsMesh.visible = visible
      if (!visible) {
        parcelsMesh.count = 0
        labelsMesh.count = 0
        return
      }

      parcelIds.length = 0
      parcelById.clear()
      let n = 0
      for (const parcel of parcels) {
        if (n >= MAX_PARCELS) break
        if (parcel.stage === 'dispatched') continue

        // A bigger consignment is a visibly bigger box.
        const s = Math.min(1.45, 0.86 + parcel.cartons * 0.13)
        const lift = parcel.stage === 'staged' ? 0 : PARCEL_LIFT
        posVec.set(parcel.pos.x, parcel.pos.y + lift, parcel.pos.z)
        quat.setFromAxisAngle(UP, parcel.heading)
        scaleVec.set(s, s, s)
        matrix.compose(posVec, quat, scaleVec)
        parcelsMesh.setMatrixAt(n, matrix)

        // Cardboard, nudged towards the channel hue so a held parcel is still
        // identifiable at a distance; the label carries the actual channel.
        channelTint.setHex(CHANNEL[parcel.channel])
        tint.copy(cartonColor).lerp(channelTint, 0.16)
        if (parcel.blocked) tint.lerp(tapeColor, 0.35)
        parcelsMesh.setColorAt(n, tint)

        posVec.y += 0.152 * s
        matrix.compose(posVec, quat, scaleVec)
        labelsMesh.setMatrixAt(n, matrix)
        labelsMesh.setColorAt(n, channelTint)

        parcelIds.push(parcel.id)
        parcelById.set(parcel.id, parcel)
        n++
      }

      parcelsMesh.count = n
      labelsMesh.count = n
      parcelsMesh.instanceMatrix.needsUpdate = true
      labelsMesh.instanceMatrix.needsUpdate = true
      if (parcelsMesh.instanceColor) parcelsMesh.instanceColor.needsUpdate = true
      if (labelsMesh.instanceColor) labelsMesh.instanceColor.needsUpdate = true
    },

    syncStations(stations, dt) {
      stations.forEach((station, i) => {
        const visual = stationVisuals[i]
        if (!visual) return
        const packing = station.phase === 'packing'
        const color =
          station.phase === 'packing'
            ? theme.pack.beaconPacking
            : station.phase === 'mergeBlocked'
              ? theme.pack.beaconBlocked
              : station.phase === 'unstaffed'
                ? theme.pack.beaconClosed
                : theme.pack.beaconIdle

        visual.beaconMat.color.set(color)
        visual.beaconMat.emissive.set(color)
        // A blocked bench flashes; a working one glows steadily.
        visual.phase += dt * (station.phase === 'mergeBlocked' ? 7 : 2.2)
        visual.beaconMat.emissiveIntensity =
          station.phase === 'mergeBlocked'
            ? 0.5 + 0.7 * (Math.sin(visual.phase) * 0.5 + 0.5)
            : station.phase === 'unstaffed'
              ? 0.12
              : 0.95

        visual.group.visible = station.staffed || station.job !== null
        visual.carton.visible = packing
        // Hands work the carton while packing and rest on the bench otherwise.
        const swing = packing ? Math.sin(visual.phase * 2.4) * 0.34 : 0
        if (visual.arms[0]) visual.arms[0].rotation.x = -0.75 + swing
        if (visual.arms[1]) visual.arms[1].rotation.x = -0.75 - swing
        if (packing) visual.carton.rotation.y = Math.sin(visual.phase) * 0.12
      })
    },

    parcelIdAt(instanceId) {
      return parcelIds[instanceId] ?? null
    },

    parcelPosition(id) {
      const parcel = parcelById.get(id)
      if (!parcel) return null
      const lift = parcel.stage === 'staged' ? 0 : PARCEL_LIFT
      return new THREE.Vector3(parcel.pos.x, parcel.pos.y + lift, parcel.pos.z)
    },

    dispose() {
      parcelsMesh.dispose()
      labelsMesh.dispose()
      for (const sprite of sprites) disposeSprite(sprite)
      for (const texture of beltTextures) texture.dispose()
      for (const item of disposables) item.dispose()
    },
  }
}

/** Orientation frame for a belt segment: local X across, Y along, Z up-normal. */
function orient(a: Vec3, b: Vec3): { matrix: THREE.Matrix4; length: number } | null {
  const from = new THREE.Vector3(a.x, a.y, a.z)
  const to = new THREE.Vector3(b.x, b.y, b.z)
  const dir = new THREE.Vector3().subVectors(to, from)
  const length = dir.length()
  if (length < 1e-4) return null
  dir.divideScalar(length)

  const side = new THREE.Vector3().crossVectors(dir, UP)
  if (side.lengthSq() < 1e-6) side.set(1, 0, 0)
  side.normalize()
  const normal = new THREE.Vector3().crossVectors(side, dir).normalize()

  const matrix = new THREE.Matrix4()
    .makeBasis(side, dir, normal)
    .setPosition(from.add(to).multiplyScalar(0.5))
  return { matrix, length }
}

/** Local offset inside a segment's frame: across the belt, and up its normal. */
function offset(across: number, up: number): THREE.Matrix4 {
  return new THREE.Matrix4().makeTranslation(across, 0, up)
}

function makeBeltMesh(
  a: Vec3,
  b: Vec3,
  width: number,
  base: THREE.Texture,
  powered: boolean,
): { mesh: THREE.Mesh; texture: THREE.Texture } | null {
  const frame = orient(a, b)
  if (!frame) return null

  // Cloned per segment: repeat is a texture property, and every run is a
  // different length, so a shared texture would stretch the cleats.
  const texture = base.clone()
  texture.needsUpdate = true
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(1, Math.max(1, frame.length / BELT_TILE))

  const material = new THREE.MeshStandardMaterial({
    map: texture,
    roughness: powered ? 0.82 : 0.55,
    metalness: powered ? 0.12 : 0.45,
    color: powered ? 0xffffff : 0xb9c4d2,
    // The overhead run is seen from underneath as often as from above, and it
    // shades the apron below it, which is what sells the height.
    side: THREE.DoubleSide,
  })
  const geometry = new THREE.PlaneGeometry(width, frame.length)
  const mesh = new THREE.Mesh(geometry, material)
  mesh.quaternion.setFromRotationMatrix(frame.matrix)
  mesh.position.setFromMatrixPosition(frame.matrix)
  mesh.receiveShadow = true
  mesh.castShadow = true
  return { mesh, texture }
}

/** Belt surface: a dark band with moulded cleats, tiled along the run. */
function makeBeltTexture(belt: string, cleat: string): THREE.Texture {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = belt
  ctx.fillRect(0, 0, size, size)

  ctx.strokeStyle = cleat
  ctx.lineWidth = 5
  ctx.beginPath()
  ctx.moveTo(0, size * 0.5)
  ctx.lineTo(size, size * 0.5)
  ctx.stroke()

  // A chevron gives the belt an unmistakable direction of travel.
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.moveTo(size * 0.18, size * 0.12)
  ctx.lineTo(size * 0.5, size * 0.32)
  ctx.lineTo(size * 0.82, size * 0.12)
  ctx.stroke()

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.anisotropy = 4
  return texture
}
