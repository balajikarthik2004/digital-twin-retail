import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { WalkerState } from '../inbound/walker'
import type { Route } from '../pathfinding/types'
import type { PackStation, Parcel, PickerAgent } from '../simulation/types'
import type { Bin, WarehouseModel } from '../warehouse/types'
import { buildWarehouse, type BinColorMode, type WarehouseVisual } from './buildWarehouse'
import { CAMERA_PRESETS, CameraTween, poseFor, type CameraPresetId } from './cameraPresets'
import { makeTextSprite } from './labels'
import type { ThemeMode } from '../ui/theme'
import { buildPackLine, type PackLineVisual } from './packLineMesh'
import { aimBeam, animateGait, createPickerVisual, reachFor, type PickerVisual } from './pickerMesh'
import { PathRibbon, polylineUpTo } from './ribbon'
import { sceneTheme, type SceneTheme } from './theme'

export type SceneSelection =
  | { kind: 'bin'; id: string }
  | { kind: 'agent'; id: string }
  | { kind: 'parcel'; id: string }
  | null

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
  /** Which agent's pick sequence is annotated with numbered markers. */
  focusAgentId: string | null
}

export interface SceneCallbacks {
  onSelect(selection: SceneSelection): void
  onHoverChange(hovering: boolean): void
}

const DEFAULT_OPTIONS: SceneOptions = {
  showPaths: true,
  showSequence: true,
  showParcels: true,
  binColorMode: 'velocity',
  focusAgentId: null,
}

/** Max numbered markers rendered for the focused route. */
const MAX_MARKERS = 60

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
  private hoverActive = false

  private tween = new CameraTween()
  private preset: CameraPresetId = 'overview'

  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()
  private pointerDownAt = { x: 0, y: 0, time: 0 }
  private resizeObserver: ResizeObserver
  private disposed = false
  private tmpA = new THREE.Vector3()
  private tmpB = new THREE.Vector3()
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
    this.renderer.shadowMap.type = THREE.PCFShadowMap
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
    this.dirLight.shadow.bias = -0.0006
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

    const dom = this.renderer.domElement
    dom.addEventListener('pointerdown', this.handlePointerDown)
    dom.addEventListener('pointerup', this.handlePointerUp)
    dom.addEventListener('pointermove', this.handlePointerMove)

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

    const fog = this.scene.fog as THREE.Fog
    fog.near = span * 0.5
    fog.far = span * 3.2

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
  markPlaced(binId: string): void {
    this.visual?.recolorBin(binId)
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
    const model = this.model
    if (!model) return
    this.selectionBox.visible = false

    if (this.selection?.kind === 'bin') {
      const bin = model.binsById.get(this.selection.id)
      if (bin) {
        const c = model.config
        const slotWidth = c.bayWidth / c.slotsPerBay
        this.selectionBox.scale.set(c.rackDepth * 0.8, c.levelHeight * 0.66, slotWidth * 0.96)
        const facing = bin.side === 'L' ? 1 : -1
        this.selectionBox.position.set(
          bin.face.x - facing * (c.rackDepth * 0.36),
          bin.face.y,
          bin.face.z,
        )
        this.selectionBox.visible = true
      }
    }

    // Ring colour/opacity is owned by the per-frame sync; only scale here.
    for (const [id, picker] of this.pickers) {
      const active = this.selection?.kind === 'agent' && this.selection.id === id
      picker.ring.scale.setScalar(active ? 1.25 : 1)
    }
  }

  selectionWorldPosition(): THREE.Vector3 | null {
    if (!this.selection || !this.model) return null
    if (this.selection.kind === 'bin') {
      const bin = this.model.binsById.get(this.selection.id)
      if (!bin) return null
      const facing = bin.side === 'L' ? 1 : -1
      return new THREE.Vector3(bin.face.x + facing * 0.3, bin.face.y + 0.35, bin.face.z)
    }
    if (this.selection.kind === 'parcel') {
      const pos = this.packLine?.parcelPosition(this.selection.id)
      return pos ? pos.setY(pos.y + 0.3) : null
    }
    const picker = this.pickers.get(this.selection.id)
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

    this.syncAgents(agents, dt)
    this.syncPackLine(packLine, dt)
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
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
    const plan = this.ensureRibbon(this.planRibbons, agent.id, agent.color, 0.34, this.theme.ribbonPlan)
    const walked = this.ensureRibbon(this.walkedRibbons, agent.id, agent.color, 0.5, this.theme.ribbonWalked)

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
    if (tintsStale) {
      for (const wp of agent.route.waypoints) {
        const done = wp.sequence <= agent.nextWaypoint
        visual.tintBin(wp.stop.ref, done ? this.theme.binDone : agent.color)
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
  ): PathRibbon {
    let ribbon = store.get(id)
    if (!ribbon) {
      ribbon = new PathRibbon(color, width, 1024, opacity)
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
    const parcelMesh = this.packLine?.parcelsMesh
    const parcelHits =
      parcelMesh && parcelMesh.visible && parcelMesh.count > 0
        ? this.raycaster.intersectObject(parcelMesh, false)
        : []

    const agentHit = agentHits[0]
    const binHit = binHits[0]
    const parcelHit = parcelHits[0]

    // A parcel is small and always in front of whatever it is riding over, so it
    // wins outright when the ray actually touches one.
    if (parcelHit && parcelHit.instanceId !== undefined) {
      const id = this.packLine?.parcelIdAt(parcelHit.instanceId)
      const closer =
        (!agentHit || parcelHit.distance < agentHit.distance) &&
        (!binHit || parcelHit.distance < binHit.distance)
      if (id && closer) return { kind: 'parcel', id }
    }
    // Agents win ties within half a metre so a picker in front of a rack is clickable.
    if (agentHit && (!binHit || agentHit.distance < binHit.distance + 0.5)) {
      return { kind: 'agent', id: String(agentHit.object.userData.id) }
    }
    if (binHit && binHit.instanceId !== undefined) {
      const bin = this.visual.binOrder[binHit.instanceId]
      if (bin) return { kind: 'bin', id: bin.id }
    }
    return null
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
    const hovering = this.pick() !== null
    if (hovering !== this.hoverActive) {
      this.hoverActive = hovering
      this.renderer.domElement.style.cursor = hovering ? 'pointer' : 'grab'
      this.callbacks.onHoverChange(hovering)
    }
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
    this.selectionBox.geometry.dispose()
    ;(this.selectionBox.material as THREE.Material).dispose()
    this.renderer.dispose()
    if (dom.parentElement === this.container) this.container.removeChild(dom)
  }
}

function hexString(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`
}

function lerpAngle(from: number, to: number, t: number): number {
  let delta = (to - from) % (Math.PI * 2)
  if (delta > Math.PI) delta -= Math.PI * 2
  if (delta < -Math.PI) delta += Math.PI * 2
  return from + delta * t
}
