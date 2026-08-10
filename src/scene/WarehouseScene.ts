import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import type { WalkerState } from '../inbound/walker'
import type { Route } from '../pathfinding/types'
import type { DockActivity } from '../simulation/dockActivity'
import type { PackStation, Parcel, PickerAgent } from '../simulation/types'
import type { Bin, WarehouseModel } from '../warehouse/types'
import { buildWarehouse, type BinColorMode, type WarehouseVisual } from './buildWarehouse'
import { CAMERA_PRESETS, CameraTween, poseFor, type CameraPresetId } from './cameraPresets'
import { makeTextSprite } from './labels'
import type { ThemeMode } from '../ui/theme'
import { buildPackLine, type PackLineVisual } from './packLineMesh'
import { aimBeam, animateGait, createPickerVisual, reachFor, type PickerVisual } from './pickerMesh'
import { PathRibbon, polylineUpTo, tickRibbonFlow, type RibbonVariant } from './ribbon'
import { sceneTheme, type SceneTheme } from './theme'

export type SceneSelection =
  | { kind: 'bin'; id: string }
  | { kind: 'agent'; id: string }
  | { kind: 'parcel'; id: string }
  | { kind: 'dock'; id: string }
  | null

/** What the pointer is currently over, for the hover read-out. */
export type SceneHover = Exclude<SceneSelection, null> | null

/** Live pack-out state pushed in every frame, straight from the engine. */
export interface PackLineFrame {
  parcels: Parcel[]
  stations: PackStation[]
  /** Belt speed, m/s — drives the conveyor surface animation. */
  speed: number
}

export interface SceneOptions {
  showPaths: boolean
  showSequence: boolean
  /** Render parcels and animate the conveyor. */
  showParcels: boolean
  binColorMode: BinColorMode
  /** Paint empty and at-replen locations in the occupancy colours. */
  showOccupancy: boolean
  /** Which agent's pick sequence is annotated with numbered markers. */
  focusAgentId: string | null
}

export interface SceneCallbacks {
  onSelect(selection: SceneSelection): void
  /**
   * What the pointer is over, or null. Fires only on a change, so a host can
   * hang a hover read-out off it without polling.
   */
  onHover(target: SceneHover): void
}

/**
 * Continuous camera drive — arrow keys / WASD, or the on-screen pad.
 *
 * Each axis is a signed intent held for as long as the key or button is down,
 * integrated per frame, so movement is smooth rather than stepped.
 */
export interface MoveAxes {
  /** +1 towards where the camera is looking, -1 away. */
  forward: number
  /** +1 right of the view direction, -1 left. */
  right: number
  /** +1 rises, -1 drops. */
  up: number
  sprint: boolean
}

const ZERO_AXES: MoveAxes = { forward: 0, right: 0, up: 0, sprint: false }

/**
 * Physical-key layout, games-style: `code` not `key`, so the keys stay in the
 * same place on a non-QWERTY keyboard and are unaffected by modifiers.
 */
const MOVE_KEYS: Record<string, Partial<MoveAxes>> = {
  ArrowUp: { forward: 1 },
  KeyW: { forward: 1 },
  ArrowDown: { forward: -1 },
  KeyS: { forward: -1 },
  ArrowLeft: { right: -1 },
  KeyA: { right: -1 },
  ArrowRight: { right: 1 },
  KeyD: { right: 1 },
  PageUp: { up: 1 },
  KeyE: { up: 1 },
  PageDown: { up: -1 },
  KeyQ: { up: -1 },
}

/**
 * Simulated seconds a pad tap is guaranteed, so a single click always moves you.
 *
 * Measured in integrated `dt`, not wall-clock: on a slow machine a 200 ms press
 * can be under one rendered frame, and a button that does nothing on a laptop
 * with weak graphics is a broken button.
 */
const PAD_MIN_HOLD = 0.22

/** Metres per second, as a share of how far out the camera is sitting. */
const MOVE_RATE = 0.55
const MIN_SPEED = 3.5
const MAX_SPEED = 55
const SPRINT = 2.6
/** Eye height floor, so you cannot drive the camera under the slab. */
const MIN_EYE = 1.4
/** How far outside the building you may roam. */
const ROAM_MARGIN = 14

/** Radians/second of orbit at full stick deflection (hand-control rotate). */
const ROTATE_RATE = 1.6
/** Fraction of distance-to-target zoomed per second at full stick deflection. */
const ZOOM_RATE = 1.1
/** Kept off true vertical, same reasoning as the polar limit below — an orbit
 *  that reaches exactly zenith/nadir loses azimuth and the view can snap. */
const MIN_POLAR = 0.03

const DEFAULT_OPTIONS: SceneOptions = {
  showPaths: true,
  showSequence: true,
  showParcels: true,
  binColorMode: 'velocity',
  showOccupancy: true,
  focusAgentId: null,
}

/** Max numbered markers rendered for the focused route. */
const MAX_MARKERS = 60

/** Metres below the roof deck at which the roof steel stops being drawn. */
const ROOF_CUT = 1.6

/**
 * Fog is the building's air, and air only hazes what you look *through* it at.
 *
 * At aisle level the far end of the module is 60-70 m of air away and should fade;
 * from a plan view 80 m up you are looking *down at* the floor through almost
 * none of it, so the same fog range washes the whole layout out into a flat milky
 * sheet — exactly where crisp is what a plan view is for. So the range is pushed
 * out as the camera climbs: eye height gets the full effect, an overview keeps a
 * little depth at the far wall, and straight down gets none.
 */
const EYE_LEVEL = 1.7
const FOG_LIFT = 1.2

/**
 * Owns the WebGL scene. Intentionally has no React or store dependency: the
 * host calls `frame(dt, agents)` once per animation frame with live agent state
 * straight from the simulation engine, so 3D motion never waits on a re-render.
 */
export class WarehouseScene {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  readonly controls: OrbitControls

  private container: HTMLElement
  private callbacks: SceneCallbacks
  private options: SceneOptions = { ...DEFAULT_OPTIONS }

  private model: WarehouseModel | null = null
  private visual: WarehouseVisual | null = null
  private packLine: PackLineVisual | null = null
  private mode: ThemeMode
  private theme: SceneTheme
  private hemiLight: THREE.HemisphereLight
  private dirLight: THREE.DirectionalLight
  private fillLight: THREE.DirectionalLight
  /** Image-based ambient, built once and shared by both themes. */
  private envMap: THREE.Texture | null = null

  private pickers = new Map<string, PickerVisual>()
  private planRibbons = new Map<string, PathRibbon>()
  private walkedRibbons = new Map<string, PathRibbon>()
  /** Route a plan ribbon was last built from, so it is only rebuilt on change. */
  private planRibbonRoute = new Map<string, Route>()
  private agentGroup = new THREE.Group()

  private markerPool: THREE.Sprite[] = []
  private markerGroup = new THREE.Group()

  /** Inbound putaway roadmap: goods-in → the chosen free location. */
  private putawayRibbon: PathRibbon | null = null
  /** Bin tints owned by the putaway shortlist, re-applied after every agent pass. */
  private putawayTints = new Map<string, number>()
  /** The operator physically walking a putaway, when one is in flight. */
  private walker: PickerVisual | null = null

  private selection: SceneSelection = null
  private selectionBox: THREE.LineSegments
  /** Wireframe glow for whatever the hand-pointing gesture is aimed at — kept
   *  entirely separate from {@link selectionBox} so pointing can highlight
   *  something without selecting it (selecting opens the Inspector; pointing
   *  must not). */
  private pointerBox: THREE.LineSegments
  private pointerTarget: SceneSelection = null
  private hover: SceneHover = null
  /** Latest dock state, kept so a rebuilt visual can be re-stamped with it. */
  private dockStates: DockActivity[] = []

  private tween = new CameraTween()
  private preset: CameraPresetId = 'overview'
  /** Fog range at eye level; {@link EYE_LEVEL} explains how it is lifted. */
  private fogBase = { near: 60, far: 260 }

  /** Keys currently held, and the axes they add up to. */
  private heldKeys = new Set<string>()
  private keyAxes: MoveAxes = { ...ZERO_AXES }
  /** Axes driven by the on-screen pad, merged with the keyboard's. */
  private padAxes: MoveAxes = { ...ZERO_AXES }
  /** Last non-zero pad input, kept alive for {@link PAD_MIN_HOLD} after release. */
  private padLatched: MoveAxes = { ...ZERO_AXES }
  private padHoldLeft = 0
  /** Rotate/zoom rates from the hand control's left hand / two-hand gestures. */
  private handRotateZoom = { yaw: 0, pitch: 0, zoom: 0 }

  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()
  private pointerDownAt = { x: 0, y: 0, time: 0 }
  private resizeObserver: ResizeObserver
  private disposed = false
  private tmpA = new THREE.Vector3()
  private tmpB = new THREE.Vector3()
  private tmpC = new THREE.Vector3()
  private tmpSpherical = new THREE.Spherical()
  private tmpTarget = new THREE.Vector3()
  /** Cheap hash of route/progress/colour state, to skip redundant bin re-tinting. */
  private tintSignature = ''

  constructor(container: HTMLElement, callbacks: SceneCallbacks, mode: ThemeMode = 'light') {
    this.container = container
    this.callbacks = callbacks
    this.mode = mode
    this.theme = sceneTheme(mode)

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(container.clientWidth || 1, container.clientHeight || 1)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = this.theme.lights.exposure
    this.renderer.shadowMap.enabled = true
    // Soft shadows: a warehouse is lit by broad high bays, and a hard-edged
    // stencil under every picker is the single biggest tell that a scene is
    // synthetic. The cost is one extra tap group per shadow sample.
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.domElement.style.display = 'block'
    this.renderer.domElement.style.outline = 'none'
    this.renderer.domElement.style.position = 'absolute'
    this.renderer.domElement.style.top = '0'
    this.renderer.domElement.style.left = '0'
    this.renderer.domElement.style.width = '100%'
    this.renderer.domElement.style.height = '100%'
    container.appendChild(this.renderer.domElement)

    this.scene.background = new THREE.Color(this.theme.background)
    this.scene.fog = new THREE.Fog(this.theme.fog, 60, 260)

    // Pre-filtered radiance from a neutral room. Generated once, kept for the
    // life of the scene, and re-weighted rather than rebuilt on a theme swap.
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    pmrem.dispose()
    this.scene.environment = this.envMap
    this.scene.environmentIntensity = this.theme.lights.envIntensity

    this.camera = new THREE.PerspectiveCamera(
      52,
      (container.clientWidth || 1) / (container.clientHeight || 1),
      0.1,
      1200,
    )
    this.camera.position.set(40, 45, -60)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.maxPolarAngle = Math.PI * 0.495
    this.controls.minDistance = 3
    this.controls.maxDistance = 400
    this.controls.screenSpacePanning = false

    const L = this.theme.lights
    this.hemiLight = new THREE.HemisphereLight(L.skyColor, L.groundColor, L.hemiIntensity)
    this.scene.add(this.hemiLight)

    this.dirLight = new THREE.DirectionalLight(L.sunColor, L.sunIntensity)
    this.dirLight.castShadow = true
    this.dirLight.shadow.mapSize.set(2048, 2048)
    this.dirLight.shadow.bias = -0.0004
    // Offsetting along the surface normal instead of leaning on depth bias alone
    // is what stops thin geometry — shelf decks, forks, roof chords — from
    // shadowing itself into stripes.
    this.dirLight.shadow.normalBias = 0.035
    this.dirLight.shadow.radius = 2.4
    this.scene.add(this.dirLight, this.dirLight.target)

    this.fillLight = new THREE.DirectionalLight(L.fillColor, L.fillIntensity)
    this.fillLight.position.set(-30, 25, 40)
    this.scene.add(this.fillLight)

    this.scene.add(this.agentGroup, this.markerGroup)

    // Reusable wireframe box for the currently selected bin.
    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1))
    this.selectionBox = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: this.theme.highlight, transparent: true, opacity: 0.95 }),
    )
    this.selectionBox.visible = false
    this.selectionBox.renderOrder = 15
    this.scene.add(this.selectionBox)

    // Same geometry, a warmer/amber colour so a pointed-at rack never reads as
    // "selected" — pointing only ever highlights, pinch is what selects.
    this.pointerBox = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: 0xffb648, transparent: true, opacity: 0.9 }),
    )
    this.pointerBox.visible = false
    this.pointerBox.renderOrder = 15
    this.scene.add(this.pointerBox)

    const dom = this.renderer.domElement
    dom.addEventListener('pointerdown', this.handlePointerDown)
    dom.addEventListener('pointerup', this.handlePointerUp)
    dom.addEventListener('pointermove', this.handlePointerMove)

    // Movement is bound to the window, not the canvas: you should be able to
    // walk the floor without first clicking into the 3D view.
    window.addEventListener('keydown', this.handleKeyDown)
    window.addEventListener('keyup', this.handleKeyUp)
    window.addEventListener('blur', this.handleBlur)

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
  }

  // ── model ─────────────────────────────────────────────────────────────────

  setModel(model: WarehouseModel): void {
    this.model = model
    this.rebuildVisual()

    const { bounds } = model
    const span = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ)
    const cx = (bounds.minX + bounds.maxX) / 2
    const cz = (bounds.minZ + bounds.maxZ) / 2

    this.dirLight.position.set(cx + span * 0.35, span * 0.9, cz - span * 0.45)
    this.dirLight.target.position.set(cx, 0, cz)
    const s = span * 0.75
    const cam = this.dirLight.shadow.camera
    cam.left = -s
    cam.right = s
    cam.top = s
    cam.bottom = -s
    cam.near = 1
    cam.far = span * 3
    cam.updateProjectionMatrix()

    // Eye-level range: the far end of the module is on the edge of hazing, and
    // anything beyond the building has gone. `updateFog` lifts it with altitude.
    this.fogBase = { near: span * 0.55, far: span * 3.2 }
    this.updateFog()

    this.controls.maxDistance = span * 2.6
    this.applyPreset('overview', 0)
    this.clearAllRoutes()
  }

  private rebuildVisual(): void {
    if (this.visual) {
      this.scene.remove(this.visual.group)
      this.visual.dispose()
      this.visual = null
    }
    if (this.packLine) {
      this.scene.remove(this.packLine.group)
      this.packLine.dispose()
      this.packLine = null
    }
    if (!this.model) return
    this.visual = buildWarehouse(this.model, this.mode)
    this.visual.setColorMode(this.options.binColorMode)
    this.visual.setOccupancyOverlay(this.options.showOccupancy)
    // Door boards are canvas textures baked at build time, so a rebuilt visual
    // starts blank until it is told what its doors are doing.
    this.visual.docks.sync(this.dockStates)
    this.scene.add(this.visual.group)

    this.packLine = buildPackLine(this.model, this.mode)
    this.scene.add(this.packLine.group)

    // A rebuilt visual starts untinted, so the putaway shortlist has to be
    // stamped back on — the plan outlives a theme swap.
    this.applyPutawayTints()
  }

  /**
   * Swap the scene palette.
   *
   * Bin colours and label sprites are baked into geometry and canvas textures at
   * build time, so the warehouse and the picker meshes are rebuilt. That is a
   * one-off cost on an explicit user action, which is cheaper and far less
   * error-prone than threading live colour updates through every material.
   */
  setTheme(mode: ThemeMode): void {
    if (mode === this.mode) return
    this.mode = mode
    this.theme = sceneTheme(mode)
    const L = this.theme.lights

    this.renderer.toneMappingExposure = L.exposure
    this.scene.environmentIntensity = L.envIntensity
    ;(this.scene.background as THREE.Color).set(this.theme.background)
    ;(this.scene.fog as THREE.Fog).color.set(this.theme.fog)

    this.hemiLight.color.set(L.skyColor)
    this.hemiLight.groundColor.set(L.groundColor)
    this.hemiLight.intensity = L.hemiIntensity
    this.dirLight.color.set(L.sunColor)
    this.dirLight.intensity = L.sunIntensity
    this.fillLight.color.set(L.fillColor)
    this.fillLight.intensity = L.fillIntensity
    ;(this.selectionBox.material as THREE.LineBasicMaterial).color.set(this.theme.highlight)

    // A rebuilt visual has no tints, and ribbons/labels carry baked colours, so
    // invalidate the caches that would otherwise keep the old palette alive.
    this.planRibbonRoute.clear()
    this.tintSignature = ''
    this.rebuildVisual()
    this.disposePickers()
    this.rebuildMarkers()
    this.updateSelectionVisuals()
  }

  private disposePickers(): void {
    for (const [id, picker] of this.pickers) {
      this.agentGroup.remove(picker.group)
      picker.dispose()
      this.pickers.delete(id)
    }
  }

  private rebuildMarkers(): void {
    for (const sprite of this.markerPool) {
      if (!sprite) continue
      this.markerGroup.remove(sprite)
      const mat = sprite.material as THREE.SpriteMaterial
      mat.map?.dispose()
      mat.dispose()
    }
    this.markerPool = []
  }

  setOptions(patch: Partial<SceneOptions>): void {
    const prev = this.options
    this.options = { ...prev, ...patch }
    if (patch.binColorMode && patch.binColorMode !== prev.binColorMode) {
      this.visual?.setColorMode(patch.binColorMode)
      // A colour-mode swap drops every tint, and the putaway shortlist is a plan
      // that outlives it — the same reason a theme swap re-stamps it.
      this.tintSignature = ''
      this.applyPutawayTints()
    }
    if (patch.showOccupancy !== undefined && patch.showOccupancy !== prev.showOccupancy) {
      this.visual?.setOccupancyOverlay(patch.showOccupancy)
    }
    if (patch.showPaths === false) {
      for (const r of this.planRibbons.values()) r.hide()
      for (const r of this.walkedRibbons.values()) r.hide()
    }
    if (patch.showSequence === false || patch.focusAgentId !== undefined) {
      this.hideMarkers()
    }
  }

  get parcelsVisible(): boolean {
    return this.options.showParcels
  }

  // ── dock doors ────────────────────────────────────────────────────────────

  /**
   * Push what every door is doing.
   *
   * Called on the metrics tick rather than per frame: the boards are canvas
   * textures and the shutters interpolate on their own clock, so nothing here
   * needs a 60 Hz feed. The states are kept so a theme swap — which rebuilds every
   * mesh in the building — can put them straight back.
   */
  syncDocks(states: DockActivity[]): void {
    this.dockStates = states
    this.visual?.docks.sync(states)
  }

  /** Live state of one door, for a hover read-out or an inspector card. */
  dockState(id: string): DockActivity | null {
    return this.dockStates.find((d) => d.id === id) ?? null
  }

  // ── inbound putaway roadmap ───────────────────────────────────────────────

  /**
   * Draw (or clear) the walk from goods-in to a free location, plus the tints
   * that mark the chosen shelf and its runners-up.
   *
   * This is deliberately independent of the agent route ribbons: a putaway is a
   * plan, not something a picker is currently walking, and it has to stay on
   * screen whether the simulation is running, paused or has never been started.
   */
  setPutawayRoute(
    route: Route | null,
    shortlist: { binId: string; chosen: boolean }[] = [],
  ): void {
    const P = this.theme.putaway

    if (!route) {
      this.putawayRibbon?.hide()
      this.clearPutawayTints()
      return
    }

    if (!this.putawayRibbon) {
      this.putawayRibbon = new PathRibbon(P.route, 0.46, 1024, P.routeOpacity)
      this.putawayRibbon.mesh.renderOrder = 6
      this.scene.add(this.putawayRibbon.mesh)
    }
    this.putawayRibbon.setColor(P.route)
    this.putawayRibbon.setOpacity(P.routeOpacity)
    // Sits just above the pick-path ribbons so the roadmap stays readable when
    // it happens to share an aisle with a picker's route.
    this.putawayRibbon.setPath(route.polyline, 0.07)

    const next = new Map<string, number>()
    for (const entry of shortlist) {
      next.set(entry.binId, entry.chosen ? P.target : P.candidate)
    }
    // Restore any bin that dropped off the shortlist before applying the new set.
    for (const binId of this.putawayTints.keys()) {
      if (!next.has(binId)) this.visual?.tintBin(binId, null)
    }
    this.putawayTints = next
    this.applyPutawayTints()
  }

  /**
   * Drive the putaway operator.
   *
   * They are drawn with the same mesh, gait and pick beam as the picking fleet —
   * a putaway is the same physical act in reverse, and showing it any other way
   * would imply it costs the floor nothing.
   *
   * @param state  Pose from the walker, or null when no putaway is in flight.
   */
  syncPutawayWalker(state: WalkerState | null, dt: number, targetBinId?: string): void {
    if (!state || state.phase === 'done') {
      if (this.walker) {
        this.agentGroup.remove(this.walker.group)
        this.walker.dispose()
        this.walker = null
      }
      return
    }

    const color = hexString(this.theme.putaway.route)
    if (this.walker && this.walker.color !== color) {
      this.agentGroup.remove(this.walker.group)
      this.walker.dispose()
      this.walker = null
    }
    if (!this.walker) {
      // A pallet truck: this is a pallet of stock, not a tote.
      this.walker = createPickerVisual('putaway', 'IN', color, 'palletJack')
      this.agentGroup.add(this.walker.group)
    }

    const walker = this.walker
    const target = this.tmpTarget.set(state.pos.x, 0, state.pos.y)
    const lerp = Math.min(1, dt * 14)
    const groundSpeed = dt > 1e-5 ? walker.group.position.distanceTo(target) / dt : 0
    walker.group.position.lerp(target, lerp)
    walker.group.rotation.y = lerpAngle(walker.group.rotation.y, state.heading, lerp)

    const moving = state.phase === 'walking' || state.phase === 'returning'
    animateGait(walker, dt, moving ? Math.min(groundSpeed, 2.2) : 0)
    ;(walker.ring.material as THREE.MeshBasicMaterial).color.set(color)
    ;(walker.ring.material as THREE.MeshBasicMaterial).opacity = moving ? 0.5 : 0.95

    // Lifting the stock onto the shelf — same beam the pickers use to take it off.
    const bin = state.phase === 'placing' && targetBinId ? this.model?.binsById.get(targetBinId) : null
    if (bin) {
      this.tmpA.set(walker.group.position.x, 1.25, walker.group.position.z)
      this.tmpB.set(bin.face.x, bin.face.y, bin.face.z)
      aimBeam(walker.beam, this.tmpA, this.tmpB)
      reachFor(walker, true)
    } else {
      walker.beam.visible = false
      reachFor(walker, false)
    }
  }

  /**
   * Show the stock landing on the shelf: the roadmap comes down, the location
   * takes on its new SKU's colour, and the camera drops to shelf level so the
   * bin that just changed is the thing you are looking at.
   */
  /**
   * Re-read on-hand levels across the whole facility.
   *
   * A location's height is how full it is, so anything that moves stock without
   * a pick or a putaway behind it — a shift reset restoring opening on-hand — has
   * to be pushed in, or the racking stays drawn as it was at the end of the run.
   */
  refreshStockLevels(): void {
    this.visual?.refreshAllBins()
  }

  markPlaced(binId: string): void {
    this.visual?.refreshBin(binId)
    this.putawayRibbon?.hide()
    this.clearPutawayTints()
    this.putawayTints.set(binId, this.theme.putaway.target)
    this.applyPutawayTints()
    this.setSelection({ kind: 'bin', id: binId })
    this.focusSelection()
  }

  private applyPutawayTints(): void {
    if (!this.visual) return
    for (const [binId, color] of this.putawayTints) this.visual.tintBin(binId, color)
  }

  private clearPutawayTints(): void {
    if (this.putawayTints.size === 0) return
    for (const binId of this.putawayTints.keys()) this.visual?.tintBin(binId, null)
    this.putawayTints.clear()
  }

  // ── camera ────────────────────────────────────────────────────────────────

  get activePreset(): CameraPresetId {
    return this.preset
  }

  applyPreset(preset: CameraPresetId, duration = 0.9): void {
    if (!this.model) return
    this.preset = preset
    const next = poseFor(preset, this.model)
    if (duration <= 0) {
      this.camera.position.copy(next.position)
      this.controls.target.copy(next.target)
      this.controls.update()
      return
    }
    this.tween.start(
      { position: this.camera.position.clone(), target: this.controls.target.clone() },
      next,
      duration,
    )
  }

  /**
   * Fly to a framing that shows a whole route at once.
   *
   * `focusSelection` puts the camera an arm's length from one bin, which is the
   * wrong shot for a roadmap — from inside an aisle you cannot see the walk you
   * are being asked to take. This frames the route's own footprint instead.
   */
  frameRoute(route: Route): void {
    if (route.polyline.length === 0 || !this.model) return

    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    for (const p of route.polyline) {
      minX = Math.min(minX, p.x)
      maxX = Math.max(maxX, p.x)
      minZ = Math.min(minZ, p.y)
      maxZ = Math.max(maxZ, p.y)
    }

    const centerX = (minX + maxX) / 2
    const centerZ = (minZ + maxZ) / 2
    // A route down a single aisle is a thin sliver; the floor gives it a minimum
    // so the camera does not end up pressed against the racking.
    const span = Math.max(maxX - minX, maxZ - minZ, 18)

    this.tween.start(
      { position: this.camera.position.clone(), target: this.controls.target.clone() },
      {
        position: new THREE.Vector3(
          centerX + span * 0.28,
          Math.max(16, span * 0.82),
          minZ - span * 0.62,
        ),
        target: new THREE.Vector3(centerX, 1.5, centerZ),
      },
      0.9,
    )
  }

  // ── walking the floor ─────────────────────────────────────────────────────

  /**
   * Drive the camera from the on-screen pad. Held for as long as the button is
   * down; the caller zeroes the axis on release, and a short tap is topped up
   * to {@link PAD_MIN_HOLD} so it still registers as a step.
   */
  setPadAxes(patch: Partial<MoveAxes>): void {
    const next = { ...this.padAxes, ...patch }
    if (axesActive(next)) {
      this.padLatched = next
      this.padHoldLeft = PAD_MIN_HOLD
    }
    this.padAxes = next
  }

  /**
   * Rotate/zoom rates from the hand control (left hand = orbit, both hands = zoom).
   * Unlike {@link setPadAxes} this needs no tap-hold-over: the hand loop re-emits
   * every tracked frame, including the zero it sends the instant a pinch releases.
   */
  setHandRotateZoom(patch: { yaw: number; pitch: number; zoom: number }): void {
    this.handRotateZoom = patch
  }

  /** Pad input, or the tail of a tap that has not had its time yet. */
  private effectivePadAxes(dt: number): MoveAxes {
    if (axesActive(this.padAxes)) return this.padAxes
    if (this.padHoldLeft <= 0) return ZERO_AXES
    this.padHoldLeft -= dt
    return this.padLatched
  }

  private combinedAxes(dt: number): MoveAxes {
    const pad = this.effectivePadAxes(dt)
    return {
      // Clamped so holding a key and the pad together is not double speed.
      forward: clampAxis(this.keyAxes.forward + pad.forward),
      right: clampAxis(this.keyAxes.right + pad.right),
      up: clampAxis(this.keyAxes.up + pad.up),
      sprint: this.keyAxes.sprint || pad.sprint,
    }
  }

  /**
   * Walk the camera across the floor.
   *
   * Forward is where you are looking, flattened onto the floor plane — pressing
   * forward from an angled view should take you down the aisle, not bury the
   * camera in the concrete. Position and target move together, so orbiting
   * still works normally from wherever you stop.
   */
  private drive(dt: number): void {
    const { forward, right, up, sprint } = this.combinedAxes(dt)
    if (forward === 0 && right === 0 && up === 0) return
    // A preset fly-in would otherwise fight the input for the same camera.
    this.tween.cancel()

    const cam = this.camera.position
    const target = this.controls.target

    const fwd = this.tmpA.subVectors(target, cam)
    fwd.y = 0
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1)
    fwd.normalize()
    // Right-hand normal in the floor plane: forward × up.
    const side = this.tmpB.set(-fwd.z, 0, fwd.x)

    // Pace scales with how far out you are, so the same keys feel right at both
    // aisle level and the overview.
    const distance = cam.distanceTo(target)
    const speed =
      Math.min(MAX_SPEED, Math.max(MIN_SPEED, distance * MOVE_RATE)) * (sprint ? SPRINT : 1) * dt

    const dx = (fwd.x * forward + side.x * right) * speed
    const dz = (fwd.z * forward + side.z * right) * speed

    // Keep the point of interest inside the building (plus an apron), so the
    // warehouse can never be driven off the edge of the world.
    const bounds = this.model?.bounds
    let nx = target.x + dx
    let nz = target.z + dz
    if (bounds) {
      nx = clamp(nx, bounds.minX - ROAM_MARGIN, bounds.maxX + ROAM_MARGIN)
      nz = clamp(nz, bounds.minZ - ROAM_MARGIN, bounds.maxZ + ROAM_MARGIN)
    }
    const movedX = nx - target.x
    const movedZ = nz - target.z
    target.x = nx
    target.z = nz
    cam.x += movedX
    cam.z += movedZ

    if (up !== 0) {
      const ceiling = bounds
        ? Math.max(40, Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) * 1.7)
        : 200
      const ny = clamp(cam.y + up * speed, MIN_EYE, ceiling)
      const movedY = ny - cam.y
      cam.y = ny
      // Target rises with the camera so the pitch you set is preserved.
      target.y = Math.max(0, target.y + movedY)
    }
  }

  /**
   * Orbit and dolly the camera around `controls.target` from the hand control's
   * rotate/zoom channel — the same motion a mouse drag or wheel produces, just
   * driven by a held rate instead of a delta. Reuses `OrbitControls`' own limits
   * (`maxPolarAngle`, `minDistance`/`maxDistance`) so a hand can't do anything a
   * mouse couldn't.
   */
  private applyHandOrbitZoom(dt: number): void {
    const { yaw, pitch, zoom } = this.handRotateZoom
    if (yaw === 0 && pitch === 0 && zoom === 0) return
    // A preset fly-in would otherwise fight the input for the same camera.
    this.tween.cancel()

    const cam = this.camera.position
    const target = this.controls.target
    const offset = this.tmpC.subVectors(cam, target)
    const spherical = this.tmpSpherical.setFromVector3(offset)

    spherical.theta -= yaw * ROTATE_RATE * dt
    spherical.phi = clamp(spherical.phi - pitch * ROTATE_RATE * dt, MIN_POLAR, this.controls.maxPolarAngle)
    if (zoom !== 0) {
      spherical.radius = clamp(
        spherical.radius * (1 - zoom * ZOOM_RATE * dt),
        this.controls.minDistance,
        this.controls.maxDistance,
      )
    }

    offset.setFromSpherical(spherical)
    cam.copy(target).add(offset)
  }

  private handleKeyDown = (event: KeyboardEvent) => {
    if (event.repeat || isTypingInto(event.target)) return
    if (event.ctrlKey || event.metaKey || event.altKey) return
    if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
      this.keyAxes.sprint = true
      return
    }
    if (!(event.code in MOVE_KEYS)) return
    // Arrow keys would otherwise scroll whichever panel has focus.
    event.preventDefault()
    this.heldKeys.add(event.code)
    this.recomputeKeyAxes()
  }

  private handleKeyUp = (event: KeyboardEvent) => {
    if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
      this.keyAxes.sprint = false
      return
    }
    if (!this.heldKeys.delete(event.code)) return
    this.recomputeKeyAxes()
  }

  /** Alt-tabbing away must not leave the camera coasting forever. */
  private handleBlur = () => {
    this.heldKeys.clear()
    this.keyAxes = { ...ZERO_AXES }
    this.padAxes = { ...ZERO_AXES }
    this.padHoldLeft = 0
    this.handRotateZoom = { yaw: 0, pitch: 0, zoom: 0 }
    this.setPointerTarget(null)
  }

  private recomputeKeyAxes(): void {
    const next: MoveAxes = { ...ZERO_AXES, sprint: this.keyAxes.sprint }
    for (const code of this.heldKeys) {
      const axis = MOVE_KEYS[code]
      // Opposite keys held together cancel, exactly as they do in a game.
      if (axis.forward) next.forward = clampAxis(next.forward + axis.forward)
      if (axis.right) next.right = clampAxis(next.right + axis.right)
      if (axis.up) next.up = clampAxis(next.up + axis.up)
    }
    this.keyAxes = next
  }

  /** Fly the camera to look at the current selection. */
  focusSelection(): void {
    const focus = this.selectionWorldPosition()
    if (!focus) return
    const offset = new THREE.Vector3(9, 9, -9)
    this.tween.start(
      { position: this.camera.position.clone(), target: this.controls.target.clone() },
      { position: focus.clone().add(offset), target: focus.clone() },
      0.8,
    )
  }

  presetLabel(): string {
    return CAMERA_PRESETS.find((p) => p.id === this.preset)?.label ?? 'Custom'
  }

  // ── selection ─────────────────────────────────────────────────────────────

  setSelection(selection: SceneSelection): void {
    this.selection = selection
    this.updateSelectionVisuals()
  }

  private updateSelectionVisuals(): void {
    this.placeBox(this.selectionBox, this.selection)

    // Ring colour/opacity is owned by the per-frame sync; only scale here.
    for (const [id, picker] of this.pickers) {
      const active = this.selection?.kind === 'agent' && this.selection.id === id
      picker.ring.scale.setScalar(active ? 1.25 : 1)
    }
  }

  /**
   * Aim a wireframe box (selection or pointer) at a bin or dock. Shared by
   * {@link updateSelectionVisuals} and {@link setPointerTarget} so the two
   * highlights can never drift apart in how they size or place themselves.
   */
  private placeBox(box: THREE.LineSegments, target: SceneSelection): void {
    const model = this.model
    box.visible = false
    if (!model || !target) return

    if (target.kind === 'bin') {
      const bin = model.binsById.get(target.id)
      if (!bin) return
      const c = model.config
      const slotWidth = c.bayWidth / c.slotsPerBay
      box.scale.set(c.rackDepth * 0.8, c.levelHeight * 0.66, slotWidth * 0.96)
      const facing = bin.side === 'L' ? 1 : -1
      box.position.set(bin.face.x - facing * (c.rackDepth * 0.36), bin.face.y, bin.face.z)
      box.visible = true
    } else if (target.kind === 'dock') {
      const bounds = this.visual?.docks.boundsOf(target.id)
      if (!bounds) return
      box.scale.copy(bounds.size)
      box.position.copy(bounds.center)
      box.visible = true
    }
  }

  /**
   * What the hand-pointing gesture is currently aimed at — highlight only,
   * never a selection. `null` clears the glow (hand lowered, lost the
   * target, or something else took input priority).
   *
   * Bins and dock doors get the wireframe glow; pickers already carry their
   * own highlight ring, and re-scaling it here would fight the per-frame sync
   * in {@link syncAgents}, so an agent target just skips the 3D highlight and
   * relies on the hand-control panel's name card instead.
   */
  setPointerTarget(target: SceneSelection): void {
    if (sameTarget(this.pointerTarget, target)) return
    this.pointerTarget = target
    this.placeBox(this.pointerBox, target)
  }

  /**
   * Raycast at an arbitrary point in NDC space (`[-1, 1]` on each axis),
   * independent of the mouse pick/hover pipeline — used by hand-pointing so it
   * can query "what's under this point" every tracked frame without touching
   * `this.hover`, the cursor, or firing `onHover`/`onSelect`.
   */
  pickAt(ndcX: number, ndcY: number): SceneSelection {
    this.pointer.set(ndcX, ndcY)
    return this.pick()
  }

  selectionWorldPosition(): THREE.Vector3 | null {
    return this.worldPositionOf(this.selection)
  }

  /** Where a card describing `target` should point. */
  worldPositionOf(target: SceneSelection): THREE.Vector3 | null {
    if (!target || !this.model) return null
    if (target.kind === 'bin') {
      const bin = this.model.binsById.get(target.id)
      if (!bin) return null
      const facing = bin.side === 'L' ? 1 : -1
      return new THREE.Vector3(bin.face.x + facing * 0.3, bin.face.y + 0.35, bin.face.z)
    }
    if (target.kind === 'parcel') {
      const pos = this.packLine?.parcelPosition(target.id)
      return pos ? pos.setY(pos.y + 0.3) : null
    }
    if (target.kind === 'dock') {
      return this.visual?.docks.anchorOf(target.id) ?? null
    }
    const picker = this.pickers.get(target.id)
    if (!picker) return null
    return picker.group.position.clone().setY(2.25)
  }

  /** Project a world point into container-relative CSS pixels. */
  project(world: THREE.Vector3): { x: number; y: number; visible: boolean } {
    const v = world.clone().project(this.camera)
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    return {
      x: (v.x * 0.5 + 0.5) * w,
      y: (-v.y * 0.5 + 0.5) * h,
      visible: v.z < 1 && v.x > -1.15 && v.x < 1.15 && v.y > -1.2 && v.y < 1.2,
    }
  }

  // ── per-frame update ──────────────────────────────────────────────────────

  frame(dt: number, agents: PickerAgent[], packLine: PackLineFrame | null = null): void {
    if (this.disposed) return

    const pose = this.tween.update(dt)
    if (pose) {
      this.camera.position.copy(pose.position)
      this.controls.target.copy(pose.target)
    }
    // After the tween, so driving always wins over a preset still flying in.
    this.drive(dt)
    this.applyHandOrbitZoom(dt)

    if (this.options.showPaths) tickRibbonFlow(dt)
    this.syncAgents(agents, dt)
    this.syncPackLine(packLine, dt)
    this.visual?.docks.tick(dt)
    this.syncRoof()
    this.updateFog()
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
  }

  /**
   * Drop the roof steel once the camera is above it.
   *
   * Walls and the ceiling deck are single-sided and face inwards, so they
   * disappear on their own from outside. The trusses and high bays are solid
   * boxes and would otherwise sit between an overhead camera and the floor —
   * which is the one view where seeing the whole pick path is the entire point.
   *
   * The cut is the underside of the roof steel, not the deck: a camera level with
   * the trusses is looking through a thicket of chords and light housings, so it
   * is treated as being above the roof rather than under it.
   */
  private syncRoof(): void {
    const visual = this.visual
    if (!visual) return
    const visible = this.camera.position.y < visual.roofHeight - ROOF_CUT
    if (visual.roof.visible !== visible) visual.roof.visible = visible
  }

  /** Push the fog range out as the camera climbs — see {@link EYE_LEVEL}. */
  private updateFog(): void {
    const fog = this.scene.fog as THREE.Fog | null
    if (!fog) return
    const lift = Math.max(0, this.camera.position.y - EYE_LEVEL) * FOG_LIFT
    fog.near = this.fogBase.near + lift
    fog.far = this.fogBase.far + lift
  }

  private syncPackLine(frame: PackLineFrame | null, dt: number): void {
    const visual = this.packLine
    if (!visual) return
    if (!frame) {
      visual.syncParcels([], false)
      return
    }
    // The belt only crawls when it is actually carrying something — a conveyor
    // running on an empty shift is a detail worth being honest about.
    const running = frame.parcels.some((p) => p.stage === 'conveying' && !p.manual)
    visual.tick(dt, running && this.options.showParcels ? frame.speed : 0)
    visual.syncParcels(frame.parcels, this.options.showParcels)
    visual.syncStations(frame.stations, dt)
  }

  private syncAgents(agents: PickerAgent[], dt: number): void {
    const model = this.model
    const visual = this.visual
    if (!model || !visual) return

    const live = new Set(agents.map((a) => a.id))
    for (const [id, picker] of this.pickers) {
      if (live.has(id)) continue
      this.agentGroup.remove(picker.group)
      picker.dispose()
      this.pickers.delete(id)
      this.dropRibbon(this.planRibbons, id)
      this.dropRibbon(this.walkedRibbons, id)
      this.planRibbonRoute.delete(id)
    }

    const focusId = this.options.focusAgentId ?? agents.find((a) => a.route)?.id ?? null

    // Route bin tints only change when a route, its progress or a colour changes.
    // Re-tinting every bin on every route every frame was ~1k Map lookups a frame
    // for nothing, so gate the whole pass on a cheap signature.
    let signature = ''
    for (const a of agents) signature += `${a.id}:${a.nextWaypoint}:${a.color}:${a.route ? '1' : '0'}|`
    const tintsStale = signature !== this.tintSignature
    if (tintsStale) {
      this.tintSignature = signature
      visual.clearTints()
    }

    for (const agent of agents) {
      let picker = this.pickers.get(agent.id)
      // Embodiment and identity colour are both baked into the mesh, so a change
      // in either means a rebuild.
      if (picker && (picker.kind !== agent.kind || picker.color !== agent.color)) {
        this.agentGroup.remove(picker.group)
        picker.dispose()
        this.pickers.delete(agent.id)
        picker = undefined
      }
      if (!picker) {
        picker = createPickerVisual(agent.id, agent.label, agent.color, agent.kind)
        this.pickers.set(agent.id, picker)
        this.agentGroup.add(picker.group)
        this.updateSelectionVisuals()
      }

      // Smooth the pose so the mesh never snaps, even at 20x time scale.
      const target = this.tmpTarget.set(agent.pos.x, 0, agent.pos.y)
      const lerp = Math.min(1, dt * 14)
      const groundSpeed = dt > 1e-5 ? picker.group.position.distanceTo(target) / dt : 0
      picker.group.position.lerp(target, lerp)
      picker.group.rotation.y = lerpAngle(picker.group.rotation.y, agent.heading, lerp)

      const walking = agent.phase === 'traveling' || agent.phase === 'returning'
      // Drive the gait from distance actually covered, so a yielding picker's
      // legs slow to a stop instead of skating.
      animateGait(picker, dt, walking ? Math.min(groundSpeed, 2.2) : 0)

      const busy = agent.phase !== 'idle' && agent.phase !== 'break'
      picker.label.visible = true
      ;(picker.ring.material as THREE.MeshBasicMaterial).color.set(
        agent.phase === 'blocked'
          ? 0xf87171
          : agent.phase === 'picking'
            ? 0xfacc15
            : agent.phase === 'break'
              ? 0x94a3b8
              : agent.color,
      )
      ;(picker.ring.material as THREE.MeshBasicMaterial).opacity =
        agent.phase === 'break' ? 0.18 : this.selection?.kind === 'agent' && this.selection.id === agent.id ? 0.95 : 0.42

      // Pick beam to the bin being serviced, plus a reach with the free arm.
      if (agent.phase === 'picking' && agent.currentBinId) {
        const bin = model.binsById.get(agent.currentBinId)
        if (bin) {
          this.tmpA.set(picker.group.position.x, 1.25, picker.group.position.z)
          this.tmpB.set(bin.face.x, bin.face.y, bin.face.z)
          aimBeam(picker.beam, this.tmpA, this.tmpB)
          reachFor(picker, true)
        }
      } else {
        picker.beam.visible = false
      }

      this.syncRoute(agent, busy, focusId === agent.id, visual, tintsStale)
    }

    // The agent pass owns `clearTints`, so the putaway shortlist is re-stamped
    // on top of it — a location being planned into outranks a pick highlight.
    if (tintsStale) this.applyPutawayTints()

    if (this.selection?.kind === 'agent') this.updateSelectionVisuals()
  }

  private syncRoute(
    agent: PickerAgent,
    busy: boolean,
    isFocus: boolean,
    visual: WarehouseVisual,
    tintsStale: boolean,
  ): void {
    // Plan = still to walk, so it marches (flow); walked = done, so it's a
    // steady solid glow — the two variants make progress along a route
    // legible at a glance instead of the two being told apart by opacity alone.
    const plan = this.ensureRibbon(this.planRibbons, agent.id, agent.color, 0.4, this.theme.ribbonPlan, 'flow')
    const walked = this.ensureRibbon(this.walkedRibbons, agent.id, agent.color, 0.5, this.theme.ribbonWalked, 'solid')

    if (!agent.route || !busy || !this.options.showPaths) {
      plan.hide()
      walked.hide()
      this.planRibbonRoute.delete(agent.id)
      if (isFocus) this.hideMarkers()
      return
    }

    walked.setColor(agent.color)
    walked.setOpacity(this.theme.ribbonWalked)
    walked.setPath(polylineUpTo(agent.route.polyline, agent.route.cumulative, agent.arc), 0.05)

    // The planned route is immutable for the life of the route, so rebuilding
    // its ribbon every frame was pure waste — dominant cost of the agent sync.
    if (this.planRibbonRoute.get(agent.id) !== agent.route) {
      this.planRibbonRoute.set(agent.id, agent.route)
      plan.setColor(agent.color)
      plan.setOpacity(this.theme.ribbonPlan)
      plan.setPath(agent.route.polyline, 0.03)
    }

    // Tint every bin on this route so the pick face is findable from a distance.
    // Three tiers, not two: the stop the picker is walking to *right now* gets
    // the full identity colour so it's the one thing that pops; the rest of
    // the queue is muted so it still reads as "this picker's route" without
    // competing with the immediate target. A flat colour on the whole route
    // made every stop look equally urgent, which none of them are.
    if (tintsStale) {
      const pending = mutePickColor(agent.color, this.theme.binDone)
      for (const wp of agent.route.waypoints) {
        const done = wp.sequence <= agent.nextWaypoint
        const current = wp.sequence === agent.nextWaypoint + 1
        visual.tintBin(wp.stop.ref, done ? this.theme.binDone : current ? agent.color : pending)
        // A serviced stop has had stock taken off it, so its box has to come
        // down. The signature this pass is gated on only goes stale when a
        // waypoint is completed, which is exactly when that is true — so this
        // costs one matrix write per pick, not a sweep of the racking.
        if (done) visual.refreshBin(wp.stop.ref)
      }
    }

    if (isFocus && this.options.showSequence) this.showMarkers(agent)
    else if (isFocus) this.hideMarkers()
  }

  private ensureRibbon(
    store: Map<string, PathRibbon>,
    id: string,
    color: string,
    width: number,
    opacity: number,
    variant: RibbonVariant = 'solid',
  ): PathRibbon {
    let ribbon = store.get(id)
    if (!ribbon) {
      ribbon = new PathRibbon(color, width, 1024, opacity, variant)
      store.set(id, ribbon)
      this.scene.add(ribbon.mesh)
    }
    return ribbon
  }

  private dropRibbon(store: Map<string, PathRibbon>, id: string): void {
    const ribbon = store.get(id)
    if (!ribbon) return
    this.scene.remove(ribbon.mesh)
    ribbon.dispose()
    store.delete(id)
  }

  private clearAllRoutes(): void {
    for (const id of [...this.planRibbons.keys()]) this.dropRibbon(this.planRibbons, id)
    for (const id of [...this.walkedRibbons.keys()]) this.dropRibbon(this.walkedRibbons, id)
    this.planRibbonRoute.clear()
    this.tintSignature = ''
    this.hideMarkers()
    // Bin ids are layout-scoped, so a plan cannot survive a model swap.
    this.putawayRibbon?.hide()
    this.putawayTints.clear()
  }

  // ── numbered pick-sequence markers ────────────────────────────────────────

  private marker(index: number): THREE.Sprite {
    let sprite = this.markerPool[index]
    if (!sprite) {
      sprite = makeTextSprite(String(index + 1), {
        fontSize: 62,
        worldHeight: 0.9,
        ...this.theme.marker,
      })
      this.markerPool[index] = sprite
      this.markerGroup.add(sprite)
    }
    return sprite
  }

  private showMarkers(agent: PickerAgent): void {
    const model = this.model
    if (!model || !agent.route) return
    const count = Math.min(agent.route.waypoints.length, MAX_MARKERS)

    for (let i = 0; i < count; i++) {
      const wp = agent.route.waypoints[i]
      const bin = model.binsById.get(wp.stop.ref)
      const sprite = this.marker(i)
      if (!bin) {
        sprite.visible = false
        continue
      }
      const facing = bin.side === 'L' ? 1 : -1
      sprite.position.set(bin.face.x + facing * 0.6, bin.face.y + 0.5, bin.face.z)
      sprite.visible = true
      const material = sprite.material as THREE.SpriteMaterial
      const done = wp.sequence <= agent.nextWaypoint
      material.opacity = done ? 0.28 : 1
    }
    for (let i = count; i < this.markerPool.length; i++) {
      if (this.markerPool[i]) this.markerPool[i].visible = false
    }
  }

  private hideMarkers(): void {
    for (const sprite of this.markerPool) if (sprite) sprite.visible = false
  }

  // ── interaction ───────────────────────────────────────────────────────────

  private updatePointer(event: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
  }

  private pick(): SceneSelection {
    if (!this.visual) return null
    this.raycaster.setFromCamera(this.pointer, this.camera)

    const hitboxes = [...this.pickers.values()].map((p) => p.hitbox)
    const agentHits = this.raycaster.intersectObjects(hitboxes, false)
    const binHits = this.raycaster.intersectObject(this.visual.binsMesh, false)
    const dockHits = this.raycaster.intersectObjects(this.visual.docks.hitboxes, false)
    const parcelMesh = this.packLine?.parcelsMesh
    const parcelHits =
      parcelMesh && parcelMesh.visible && parcelMesh.count > 0
        ? this.raycaster.intersectObject(parcelMesh, false)
        : []

    const agentHit = agentHits[0]
    const binHit = binHits[0]
    const parcelHit = parcelHits[0]
    const dockHit = dockHits[0]

    // A parcel is small and always in front of whatever it is riding over, so it
    // wins outright when the ray actually touches one.
    if (parcelHit && parcelHit.instanceId !== undefined) {
      const id = this.packLine?.parcelIdAt(parcelHit.instanceId)
      const closer =
        (!agentHit || parcelHit.distance < agentHit.distance) &&
        (!binHit || parcelHit.distance < binHit.distance) &&
        (!dockHit || parcelHit.distance < dockHit.distance)
      if (id && closer) return { kind: 'parcel', id }
    }
    // Agents win ties within half a metre so a picker in front of a rack is clickable.
    if (agentHit && (!binHit || agentHit.distance < binHit.distance + 0.5)) {
      return { kind: 'agent', id: String(agentHit.object.userData.id) }
    }
    /*
     * A door is a wall, and a ray that passes through one carries on into the
     * racking on the far side — so the door has to be compared on distance, not
     * given a fixed place in the order. Nearer wins: a bin in front of a door is
     * a bin, a door in front of a bin is a door.
     */
    const dockId = typeof dockHit?.object.userData.id === 'string' ? dockHit.object.userData.id : null
    if (dockId && (!binHit || dockHit!.distance < binHit.distance)) {
      return { kind: 'dock', id: dockId }
    }
    if (binHit && binHit.instanceId !== undefined) {
      const bin = this.visual.binOrder[binHit.instanceId]
      if (bin) return { kind: 'bin', id: bin.id }
    }
    return dockId ? { kind: 'dock', id: dockId } : null
  }

  private handlePointerDown = (event: PointerEvent) => {
    this.pointerDownAt = { x: event.clientX, y: event.clientY, time: performance.now() }
  }

  private handlePointerUp = (event: PointerEvent) => {
    // Ignore orbit drags — only treat near-stationary clicks as selection.
    const moved = Math.hypot(event.clientX - this.pointerDownAt.x, event.clientY - this.pointerDownAt.y)
    if (moved > 5 || performance.now() - this.pointerDownAt.time > 700) return
    this.updatePointer(event)
    this.callbacks.onSelect(this.pick())
  }

  private handlePointerMove = (event: PointerEvent) => {
    if (event.buttons !== 0) return
    this.updatePointer(event)
    this.setHover(this.pick())
  }

  /**
   * Publish what the pointer is over, once per change.
   *
   * A door lifts under the pointer, which is the affordance that tells you it can
   * be clicked at all — nothing else in the scene looks like a piece of building
   * and behaves like a control.
   */
  private setHover(target: SceneHover): void {
    const same = target?.kind === this.hover?.kind && target?.id === this.hover?.id
    if (same) return
    this.hover = target
    this.renderer.domElement.style.cursor = target ? 'pointer' : 'grab'
    this.visual?.docks.setHover(target?.kind === 'dock' ? target.id : null)
    this.callbacks.onHover(target)
  }

  resize(): void {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h, false)
  }

  binAt(id: string): Bin | undefined {
    return this.model?.binsById.get(id)
  }

  dispose(): void {
    this.disposed = true
    this.resizeObserver.disconnect()
    const dom = this.renderer.domElement
    dom.removeEventListener('pointerdown', this.handlePointerDown)
    dom.removeEventListener('pointerup', this.handlePointerUp)
    dom.removeEventListener('pointermove', this.handlePointerMove)
    window.removeEventListener('keydown', this.handleKeyDown)
    window.removeEventListener('keyup', this.handleKeyUp)
    window.removeEventListener('blur', this.handleBlur)
    this.controls.dispose()
    this.clearAllRoutes()
    this.walker?.dispose()
    this.walker = null
    if (this.putawayRibbon) {
      this.scene.remove(this.putawayRibbon.mesh)
      this.putawayRibbon.dispose()
      this.putawayRibbon = null
    }
    for (const picker of this.pickers.values()) picker.dispose()
    this.pickers.clear()
    for (const sprite of this.markerPool) {
      if (!sprite) continue
      const mat = sprite.material as THREE.SpriteMaterial
      mat.map?.dispose()
      mat.dispose()
    }
    this.markerPool = []
    this.visual?.dispose()
    this.packLine?.dispose()
    this.scene.environment = null
    this.envMap?.dispose()
    this.envMap = null
    this.selectionBox.geometry.dispose() // shared with pointerBox; disposing twice is a harmless no-op
    ;(this.selectionBox.material as THREE.Material).dispose()
    this.pointerBox.geometry.dispose()
    ;(this.pointerBox.material as THREE.Material).dispose()
    this.renderer.dispose()
    if (dom.parentElement === this.container) this.container.removeChild(dom)
  }
}

function hexString(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/** Axes are intents, not magnitudes — two sources never add up past full tilt. */
function clampAxis(value: number): number {
  return clamp(value, -1, 1)
}

function axesActive(axes: MoveAxes): boolean {
  return axes.forward !== 0 || axes.right !== 0 || axes.up !== 0
}

function sameTarget(a: SceneSelection, b: SceneSelection): boolean {
  return a?.kind === b?.kind && a?.id === b?.id
}

/**
 * Movement keys must never steal a keystroke from a form. The inbound panel is
 * full of text inputs, and arrow keys have to move the caret there.
 */
function isTypingInto(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return (
    tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
  )
}

function lerpAngle(from: number, to: number, t: number): number {
  let delta = (to - from) % (Math.PI * 2)
  if (delta > Math.PI) delta -= Math.PI * 2
  if (delta < -Math.PI) delta += Math.PI * 2
  return from + delta * t
}

const pickColorCache = new Map<string, number>()

/**
 * A queued (not-yet-current) pick stop's tint: the picker's identity colour,
 * pulled two-thirds of the way towards the "done" grey. Still recognisably
 * that picker's route, but visually receded behind whichever stop is next.
 * Memoized per agent colour — this runs once per busy agent per tint
 * refresh, not per bin, so the cache stays tiny.
 */
function mutePickColor(color: string, doneGrey: number): number {
  const key = `${color}:${doneGrey}`
  const cached = pickColorCache.get(key)
  if (cached !== undefined) return cached
  const muted = new THREE.Color(color).lerp(new THREE.Color(doneGrey), 0.65).getHex()
  pickColorCache.set(key, muted)
  return muted
}
