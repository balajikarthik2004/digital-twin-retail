import * as THREE from 'three'
import type { PickerKind } from '../simulation/pickerProfiles'
import { disposeSprite, makeTextSprite } from './labels'

/** Shared geometry — one allocation for every picker in the scene. */
const GEO = {
  torso: new THREE.CapsuleGeometry(0.19, 0.4, 6, 12),
  head: new THREE.SphereGeometry(0.14, 16, 12),
  vest: new THREE.CylinderGeometry(0.24, 0.26, 0.34, 14, 1, true),
  // Hard hat: a dome plus a brim. Worn in the identity colour, so it doubles as
  // a second read on who a picker is from directly overhead — where the shoulder
  // vest is the only other thing you can see.
  hatDome: new THREE.SphereGeometry(0.155, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2),
  hatBrim: new THREE.CylinderGeometry(0.185, 0.185, 0.022, 16),
  /** Reflective band, sized to sit just outside the vest it wraps. */
  band: new THREE.CylinderGeometry(0.262, 0.268, 0.045, 14, 1, true),
  limb: new THREE.CapsuleGeometry(0.058, 0.34, 4, 8),
  arm: new THREE.CapsuleGeometry(0.05, 0.3, 4, 8),
  tote: new THREE.BoxGeometry(0.42, 0.24, 0.3),
  cartBase: new THREE.BoxGeometry(0.62, 0.08, 0.9),
  cartTote: new THREE.BoxGeometry(0.5, 0.24, 0.36),
  post: new THREE.BoxGeometry(0.05, 0.62, 0.05),
  handle: new THREE.BoxGeometry(0.56, 0.05, 0.05),
  wheel: new THREE.CylinderGeometry(0.07, 0.07, 0.05, 10),
  jackFork: new THREE.BoxGeometry(0.16, 0.09, 1.5),
  pallet: new THREE.BoxGeometry(1.15, 0.12, 1.15),
  carton: new THREE.BoxGeometry(0.36, 0.3, 0.36),
  amrBody: new THREE.BoxGeometry(0.78, 0.34, 1.05),
  amrDeck: new THREE.BoxGeometry(0.86, 0.06, 1.12),
  amrMast: new THREE.CylinderGeometry(0.035, 0.035, 0.9, 8),
  amrLidar: new THREE.CylinderGeometry(0.09, 0.09, 0.07, 12),
  ring: new THREE.RingGeometry(0.52, 0.66, 32),
  beam: new THREE.CylinderGeometry(0.02, 0.02, 1, 6),
}

const MAT = {
  skin: new THREE.MeshStandardMaterial({ color: 0x9d7658, roughness: 0.75 }),
  torso: new THREE.MeshStandardMaterial({ color: 0x1e2735, roughness: 0.8 }),
  trousers: new THREE.MeshStandardMaterial({ color: 0x28323f, roughness: 0.85 }),
  cart: new THREE.MeshStandardMaterial({ color: 0x3a4658, roughness: 0.55, metalness: 0.3 }),
  steel: new THREE.MeshStandardMaterial({ color: 0x53637a, roughness: 0.4, metalness: 0.65 }),
  wheel: new THREE.MeshStandardMaterial({ color: 0x0d1218, roughness: 0.9 }),
  carton: new THREE.MeshStandardMaterial({ color: 0xa8783f, roughness: 0.9 }),
  pallet: new THREE.MeshStandardMaterial({ color: 0x8a6a42, roughness: 0.95 }),
  robot: new THREE.MeshStandardMaterial({ color: 0x222c39, roughness: 0.45, metalness: 0.4 }),
  // Retro-reflective tape: near-white and glossy, so it catches the high bays
  // from any angle exactly as the real thing does.
  band: new THREE.MeshStandardMaterial({
    color: 0xe8eef4,
    roughness: 0.28,
    metalness: 0.35,
    emissive: 0x1a2028,
    side: THREE.DoubleSide,
  }),
}

export interface PickerVisual {
  kind: PickerKind
  /** Identity colour baked into the accent material; a change means a rebuild. */
  color: string
  group: THREE.Group
  /** Invisible box used for click picking. */
  hitbox: THREE.Mesh
  ring: THREE.Mesh
  /** Beam drawn from the picker to the bin currently being picked. */
  beam: THREE.Mesh
  label: THREE.Sprite
  /** Limbs driven by the walk cycle; empty for the AMR. */
  legs: THREE.Object3D[]
  arms: THREE.Object3D[]
  /** Body node that bobs while walking. */
  body: THREE.Object3D | null
  /** Spinning lidar / status light, for the AMR. */
  spinner: THREE.Object3D | null
  /** Walk-cycle phase in radians. */
  gait: number
  dispose(): void
}

/**
 * Build a picker in one of four embodiments.
 *
 * The embodiment is not decoration — each one carries different capacity, pace
 * and aisle footprint in the simulation (see `pickerProfiles.ts`), so the shapes
 * exist to make that choice legible at a glance from any camera angle.
 */
export function createPickerVisual(
  id: string,
  label: string,
  colorHex: string,
  kind: PickerKind,
): PickerVisual {
  const color = new THREE.Color(colorHex)
  const group = new THREE.Group()
  group.name = `picker:${id}`

  const accent = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.42,
    metalness: 0.15,
    emissive: color.clone().multiplyScalar(0.34),
  })

  const legs: THREE.Object3D[] = []
  const arms: THREE.Object3D[] = []
  let body: THREE.Object3D | null = null
  let spinner: THREE.Object3D | null = null
  let hitSize = new THREE.Vector3(1.1, 1.8, 1.2)
  let hitOffset = new THREE.Vector3(0, 0.9, 0)

  if (kind === 'amr') {
    const chassis = new THREE.Mesh(GEO.amrBody, MAT.robot)
    chassis.position.y = 0.26
    chassis.castShadow = true

    const deck = new THREE.Mesh(GEO.amrDeck, accent)
    deck.position.y = 0.46

    // Payload cartons so a loaded robot reads differently from an empty one.
    const load = new THREE.Group()
    for (const [dx, dz] of [
      [-0.2, -0.28],
      [0.2, -0.28],
      [0, 0.24],
    ] as const) {
      const carton = new THREE.Mesh(GEO.carton, MAT.carton)
      carton.position.set(dx, 0.64, dz)
      carton.castShadow = true
      load.add(carton)
    }

    const mast = new THREE.Mesh(GEO.amrMast, MAT.steel)
    mast.position.set(0, 0.92, -0.42)

    const lidar = new THREE.Mesh(GEO.amrLidar, accent)
    lidar.position.set(0, 1.4, -0.42)
    spinner = lidar

    for (const dx of [-0.36, 0.36]) {
      for (const dz of [-0.36, 0.36]) {
        const wheel = new THREE.Mesh(GEO.wheel, MAT.wheel)
        wheel.rotation.z = Math.PI / 2
        wheel.position.set(dx, 0.09, dz)
        chassis.add(wheel)
      }
    }

    group.add(chassis, deck, load, mast, lidar)
    body = deck
    hitSize = new THREE.Vector3(1.1, 1.5, 1.4)
    hitOffset = new THREE.Vector3(0, 0.7, 0)
  } else {
    // ── Human figure, shared by person / cart / pallet-truck ────────────────
    const person = new THREE.Group()

    const hips = new THREE.Group()
    hips.position.y = 0.86

    const torso = new THREE.Mesh(GEO.torso, MAT.torso)
    torso.position.y = 0.26
    torso.castShadow = true

    const vest = new THREE.Mesh(GEO.vest, accent)
    vest.position.y = 0.3

    const head = new THREE.Mesh(GEO.head, MAT.skin)
    head.position.y = 0.62
    head.castShadow = true

    const bandLower = new THREE.Mesh(GEO.band, MAT.band)
    bandLower.position.y = 0.21
    const bandUpper = new THREE.Mesh(GEO.band, MAT.band)
    bandUpper.position.y = 0.38

    const hat = new THREE.Group()
    hat.position.y = 0.7
    const hatDome = new THREE.Mesh(GEO.hatDome, accent)
    hatDome.castShadow = true
    const hatBrim = new THREE.Mesh(GEO.hatBrim, accent)
    hatBrim.position.y = 0.012
    hat.add(hatDome, hatBrim)

    hips.add(torso, vest, bandLower, bandUpper, head, hat)

    // Legs pivot at the hip so the walk cycle is a simple rotation.
    for (const dx of [-0.1, 0.1]) {
      const hip = new THREE.Group()
      hip.position.set(dx, 0.86, 0)
      const leg = new THREE.Mesh(GEO.limb, MAT.trousers)
      leg.position.y = -0.23
      leg.castShadow = true
      hip.add(leg)
      person.add(hip)
      legs.push(hip)
    }

    for (const dx of [-0.24, 0.24]) {
      const shoulder = new THREE.Group()
      shoulder.position.set(dx, 1.12, 0)
      const arm = new THREE.Mesh(GEO.arm, MAT.torso)
      arm.position.y = -0.2
      shoulder.add(arm)
      person.add(shoulder)
      arms.push(shoulder)
    }

    person.add(hips)
    group.add(person)
    body = hips

    if (kind === 'person') {
      // Tote carried at the hip; the carrying arm stops swinging.
      const tote = new THREE.Mesh(GEO.tote, accent)
      tote.position.set(0.34, 0.82, 0.1)
      tote.rotation.y = 0.2
      tote.castShadow = true
      group.add(tote)
      arms.pop()
      hitSize = new THREE.Vector3(0.9, 1.8, 0.9)
    } else if (kind === 'cart') {
      const cart = new THREE.Group()
      cart.position.set(0, 0, 0.62)

      const base = new THREE.Mesh(GEO.cartBase, MAT.cart)
      base.position.y = 0.3
      base.castShadow = true
      cart.add(base)

      const toteA = new THREE.Mesh(GEO.cartTote, accent)
      toteA.position.set(0, 0.46, 0.2)
      const toteB = new THREE.Mesh(GEO.cartTote, MAT.cart)
      toteB.position.set(0, 0.46, -0.2)
      cart.add(toteA, toteB)

      for (const dx of [-0.28, 0.28]) {
        const post = new THREE.Mesh(GEO.post, MAT.cart)
        post.position.set(dx, 0.61, -0.42)
        cart.add(post)
      }
      const handle = new THREE.Mesh(GEO.handle, MAT.cart)
      handle.position.set(0, 0.9, -0.42)
      cart.add(handle)

      for (const dx of [-0.3, 0.3]) {
        for (const dz of [-0.36, 0.36]) {
          const wheel = new THREE.Mesh(GEO.wheel, MAT.wheel)
          wheel.rotation.z = Math.PI / 2
          wheel.position.set(dx, 0.08, dz)
          cart.add(wheel)
        }
      }
      group.add(cart)
      // Both hands on the handle — no arm swing.
      arms.length = 0
      hitSize = new THREE.Vector3(1.1, 1.8, 1.8)
      hitOffset = new THREE.Vector3(0, 0.9, 0.3)
    } else {
      // Pallet truck: long forks, a stacked pallet, and a real aisle footprint.
      const truck = new THREE.Group()
      truck.position.set(0, 0, 0.95)

      for (const dx of [-0.32, 0.32]) {
        const fork = new THREE.Mesh(GEO.jackFork, MAT.steel)
        fork.position.set(dx, 0.08, 0.1)
        fork.castShadow = true
        truck.add(fork)
      }

      const pallet = new THREE.Mesh(GEO.pallet, MAT.pallet)
      pallet.position.set(0, 0.2, 0.1)
      pallet.castShadow = true
      truck.add(pallet)

      // Two courses of cartons, one accent-coloured so the picker is trackable.
      let n = 0
      for (const level of [0.41, 0.71]) {
        for (const [dx, dz] of [
          [-0.26, -0.16],
          [0.26, -0.16],
          [-0.26, 0.36],
          [0.26, 0.36],
        ] as const) {
          const carton = new THREE.Mesh(GEO.carton, n++ % 3 === 0 ? accent : MAT.carton)
          carton.position.set(dx, level, dz)
          carton.castShadow = true
          truck.add(carton)
        }
      }

      const tiller = new THREE.Mesh(GEO.post, MAT.steel)
      tiller.scale.set(1.4, 1.5, 1.4)
      tiller.position.set(0, 0.5, -0.7)
      tiller.rotation.x = -0.35
      truck.add(tiller)

      for (const dx of [-0.32, 0.32]) {
        const wheel = new THREE.Mesh(GEO.wheel, MAT.wheel)
        wheel.rotation.z = Math.PI / 2
        wheel.position.set(dx, 0.07, 0.78)
        truck.add(wheel)
      }

      group.add(truck)
      arms.length = 0
      hitSize = new THREE.Vector3(1.4, 1.9, 2.6)
      hitOffset = new THREE.Vector3(0, 0.9, 0.6)
    }
  }

  const ring = new THREE.Mesh(
    GEO.ring,
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.45,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  )
  ring.rotation.x = -Math.PI / 2
  ring.position.y = 0.03

  const beam = new THREE.Mesh(
    GEO.beam,
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, depthWrite: false }),
  )
  beam.visible = false

  const hitbox = new THREE.Mesh(
    new THREE.BoxGeometry(hitSize.x, hitSize.y, hitSize.z),
    new THREE.MeshBasicMaterial({ visible: false }),
  )
  hitbox.position.copy(hitOffset)
  hitbox.userData = { kind: 'agent', id }

  const sprite = makeTextSprite(label, {
    color: '#ffffff',
    background: colorHex,
    border: 'rgba(0,0,0,0.35)',
    fontSize: 60,
    worldHeight: 0.42,
  })
  sprite.position.set(0, kind === 'amr' ? 1.75 : 2.0, 0)

  group.add(ring, beam, hitbox, sprite)

  return {
    kind,
    color: colorHex,
    group,
    hitbox,
    ring,
    beam,
    label: sprite,
    legs,
    arms,
    body,
    spinner,
    gait: 0,
    dispose() {
      accent.dispose()
      ;(ring.material as THREE.Material).dispose()
      ;(beam.material as THREE.Material).dispose()
      hitbox.geometry.dispose()
      ;(hitbox.material as THREE.Material).dispose()
      disposeSprite(sprite)
    },
  }
}

/**
 * Advance the walk cycle. `speed` is metres/second actually being covered, so a
 * yielding picker's legs slow and stop rather than skating along the floor.
 */
export function animateGait(visual: PickerVisual, dt: number, speed: number): void {
  if (visual.kind === 'amr') {
    if (visual.spinner) visual.spinner.rotation.y += dt * 6
    if (visual.body) visual.body.position.y = 0.46 + Math.sin(visual.gait) * 0.004
    visual.gait += dt * 4
    return
  }

  const stride = Math.min(1, speed / 1.4)
  visual.gait += dt * speed * 4.4
  const swing = Math.sin(visual.gait) * 0.62 * stride

  if (visual.legs[0]) visual.legs[0].rotation.x = swing
  if (visual.legs[1]) visual.legs[1].rotation.x = -swing
  if (visual.arms[0]) visual.arms[0].rotation.x = -swing * 0.7
  if (visual.arms[1]) visual.arms[1].rotation.x = swing * 0.7

  // Vertical bob is twice the stride frequency, like a real gait.
  if (visual.body) {
    visual.body.position.y = 0.86 + Math.abs(Math.sin(visual.gait)) * 0.028 * stride
  }
}

/** Raise the near arm towards the bin being picked. */
export function reachFor(visual: PickerVisual, active: boolean): void {
  const arm = visual.arms[0] ?? visual.legs[0]
  if (!arm || visual.kind === 'amr') return
  if (active) arm.rotation.x = -1.15
}

/** Aim the pick beam from the picker's shoulder to a bin face. */
export function aimBeam(beam: THREE.Mesh, fromWorld: THREE.Vector3, toWorld: THREE.Vector3): void {
  const dir = new THREE.Vector3().subVectors(toWorld, fromWorld)
  const len = dir.length()
  if (len < 1e-4) {
    beam.visible = false
    return
  }
  beam.visible = true
  beam.scale.set(1, len, 1)
  const mid = new THREE.Vector3().addVectors(fromWorld, toWorld).multiplyScalar(0.5)
  beam.parent?.worldToLocal(mid)
  beam.position.copy(mid)
  const localDir = dir.clone().normalize()
  const parent = beam.parent
  if (parent) {
    const q = new THREE.Quaternion()
    parent.getWorldQuaternion(q)
    localDir.applyQuaternion(q.invert())
  }
  beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), localDir)
}
