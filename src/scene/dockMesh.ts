import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { dockBoardLines, type DockActivity, type DockFlow } from '../simulation/dockActivity'
import type { ThemeMode } from '../ui/theme'
import type { Facility, WarehouseModel } from '../warehouse/types'
import { disposeSprite, makeTextSprite } from './labels'
import { sceneTheme } from './theme'

/**
 * Dock doors, as instruments rather than scenery.
 *
 * A door in a real building tells you what it is doing from the far end of the
 * aisle: the shutter is up or down, there is a lamp over it, and there is a board
 * beside it with the trailer's reference on it. This does the same three things
 * with the twin's own state, so the outbound and inbound flows are readable from
 * the overview shot and not only from a panel:
 *
 *   the shutter rolls up when the door is working and closes when it is idle;
 *   the lamp carries the flow colour — goods-in or dispatch — and pulses while a
 *   trailer is being loaded or unloaded;
 *   the board carries the trailer reference, the counts and a progress bar, and
 *   is redrawn only when those numbers actually change.
 *
 * Every door also owns an invisible hitbox, which is what makes it clickable and
 * hoverable in {@link WarehouseScene}. Static kit (bumpers, the leveller plate)
 * is merged across all doors, so the per-door cost is the shutter, the board and
 * the lamp — nothing that scales with the size of the layout.
 */

/** Board canvas, in texels. Wide and short, like the real sign. */
const BOARD_W = 512
const BOARD_H = 160
/** Metres the board is drawn at. */
const BOARD_WORLD_W = 3.1
const BOARD_WORLD_H = BOARD_WORLD_W * (BOARD_H / BOARD_W)

/** Opening the shutter closes over. */
const DOOR_H = 3.6
const FRAME_H = 4.2
/** Shutter travel per second, as a share of the opening. */
const ROLL_RATE = 1.6

export interface DockVisual {
  group: THREE.Group
  /** Invisible per-door boxes — the raycast targets for hover and selection. */
  hitboxes: THREE.Mesh[]
  /** Push live door state. Cheap enough for the metrics tick, not per frame. */
  sync(states: DockActivity[]): void
  /** Roll the shutters and pulse the lamps. */
  tick(dt: number): void
  /** Lift the door under the pointer; pass null to clear. */
  setHover(dockId: string | null): void
  /** Where an inspector card should point: the middle of the board. */
  anchorOf(dockId: string): THREE.Vector3 | null
  /** Wireframe box for the selected door: its centre and its extents, metres. */
  boundsOf(dockId: string): { center: THREE.Vector3; size: THREE.Vector3 } | null
  dispose(): void
}

interface DoorVisual {
  id: string
  label: string
  facility: Facility
  /** Extents of the door's clickable envelope, shutter through to board. */
  outlineSize: THREE.Vector3
  /** Shutter leaf, pivoted at the head of the opening so it rolls up. */
  leaf: THREE.Group
  doorMat: THREE.MeshStandardMaterial
  lampMat: THREE.MeshStandardMaterial
  board: THREE.Mesh
  boardTexture: THREE.CanvasTexture
  boardCanvas: HTMLCanvasElement
  outline: THREE.LineSegments
  /** What the board is currently showing, so it is only redrawn on a change. */
  signature: string
  flow: DockFlow
  /** 0 closed, 1 fully rolled up. */
  open: number
  openTarget: number
  pulse: number
  active: boolean
}

export function buildDocks(model: WarehouseModel, themeMode: ThemeMode): DockVisual {
  const theme = sceneTheme(themeMode)
  const F = theme.dockFlow
  const group = new THREE.Group()
  group.name = 'docks'

  const disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = []
  const sprites: THREE.Sprite[] = []
  const hitboxes: THREE.Mesh[] = []
  const doors: DoorVisual[] = []
  const byId = new Map<string, DoorVisual>()

  const frameMat = new THREE.MeshStandardMaterial({
    color: theme.dock,
    roughness: 0.6,
    metalness: 0.25,
  })
  const rubberMat = new THREE.MeshStandardMaterial({ color: theme.props.rubber, roughness: 0.95 })
  // The opening behind the shutter: a trailer box backed onto the door is the
  // darkest thing in the building, which is what makes an open door read as open.
  const voidMat = new THREE.MeshStandardMaterial({
    color: theme.props.rubber,
    roughness: 1,
    metalness: 0,
  })
  const lampGeo = new THREE.SphereGeometry(0.13, 14, 10)
  const boardEdgeMat = new THREE.MeshStandardMaterial({
    color: theme.dock,
    roughness: 0.5,
    metalness: 0.4,
  })
  disposables.push(frameMat, rubberMat, voidMat, lampGeo, boardEdgeMat)

  /** Static kit across every door, merged once. */
  const bumperGeos: THREE.BufferGeometry[] = []
  const plateGeos: THREE.BufferGeometry[] = []

  const facilities = model.facilities.filter((f) => f.kind === 'dock')

  for (const facility of facilities) {
    const { x } = facility.pos
    const z = facility.pos.y

    // ── Structure ──────────────────────────────────────────────────────────
    const frameGeo = new THREE.BoxGeometry(facility.width + 0.5, FRAME_H, 0.5)
    const frame = new THREE.Mesh(frameGeo, frameMat)
    frame.position.set(x, FRAME_H / 2, z - 0.3)
    group.add(frame)
    disposables.push(frameGeo)

    const voidGeo = new THREE.PlaneGeometry(facility.width, DOOR_H)
    const voidPanel = new THREE.Mesh(voidGeo, voidMat)
    voidPanel.position.set(x, 0.05 + DOOR_H / 2, z - 0.04)
    group.add(voidPanel)
    disposables.push(voidGeo)

    // ── Shutter ────────────────────────────────────────────────────────────
    // Pivoted at the head of the opening: scaling the leaf in Y therefore rolls
    // it up into the header rather than shrinking it about its middle.
    const leaf = new THREE.Group()
    leaf.position.set(x, 0.05 + DOOR_H, z)
    group.add(leaf)

    /*
     * The shutter keeps its own paint.
     *
     * Washing the flow colour over it was tried and dropped: an open door is
     * rolled up into a 100 mm strip, so the only thing the tint changed was the
     * colour of that strip — and blue steel under an amber emissive reads as
     * neither. Flow is carried by the lamp, the board and whether the door is
     * open at all, which are the three things you can actually see. The emissive
     * is left as a hover channel only.
     */
    const doorMat = new THREE.MeshStandardMaterial({
      color: theme.dockDoor,
      roughness: 0.5,
      metalness: 0.3,
      emissive: new THREE.Color(F.hover),
      emissiveIntensity: 0,
    })
    const panelGeo = new THREE.BoxGeometry(facility.width, DOOR_H, 0.12)
    const panel = new THREE.Mesh(panelGeo, doorMat)
    panel.position.y = -DOOR_H / 2
    leaf.add(panel)
    disposables.push(doorMat, panelGeo)

    // Slats: a sectional door is a stack of panels, and the shadow lines between
    // them are most of what makes it read as a door at all. Merged per leaf, so
    // they roll with it.
    const slatGeos: THREE.BufferGeometry[] = []
    for (let s = 1; s <= 7; s++) {
      const geo = new THREE.BoxGeometry(facility.width - 0.06, 0.05, 0.06)
      geo.translate(0, -DOOR_H * (s / 8), 0.08)
      slatGeos.push(geo)
    }
    const slatsMerged = mergeGeometries(slatGeos)
    slatGeos.forEach((g) => g.dispose())
    if (slatsMerged) {
      leaf.add(new THREE.Mesh(slatsMerged, rubberMat))
      disposables.push(slatsMerged)
    }

    // Bumpers either side at trailer-bed height, and the leveller plate the
    // pallet truck actually drives over.
    for (const dx of [-1, 1]) {
      bumperGeos.push(boxAt(x + dx * (facility.width / 2 + 0.16), 1.05, z + 0.1, 0.22, 0.5, 0.3))
    }
    plateGeos.push(boxAt(x, 0.05, z + 0.95, facility.width - 0.2, 0.06, 1.6))

    // ── Status board ───────────────────────────────────────────────────────
    const boardCanvas = document.createElement('canvas')
    boardCanvas.width = BOARD_W
    boardCanvas.height = BOARD_H
    const boardTexture = new THREE.CanvasTexture(boardCanvas)
    boardTexture.colorSpace = THREE.SRGBColorSpace
    boardTexture.minFilter = THREE.LinearFilter
    boardTexture.generateMipmaps = false
    boardTexture.anisotropy = 4

    const boardGeo = new THREE.PlaneGeometry(BOARD_WORLD_W, BOARD_WORLD_H)
    const boardMat = new THREE.MeshBasicMaterial({ map: boardTexture, transparent: true })
    const board = new THREE.Mesh(boardGeo, boardMat)
    // Above the header and facing into the building: a sign hung over the opening,
    // where anyone reading it is standing, and never across the opening itself.
    board.position.set(x, FRAME_H + BOARD_WORLD_H / 2 + 0.12, z + 0.1)
    group.add(board)
    disposables.push(boardGeo, boardMat, boardTexture)

    const bezelGeo = new THREE.BoxGeometry(BOARD_WORLD_W + 0.08, BOARD_WORLD_H + 0.08, 0.05)
    const bezel = new THREE.Mesh(bezelGeo, boardEdgeMat)
    bezel.position.set(board.position.x, board.position.y, z + 0.07)
    group.add(bezel)
    disposables.push(bezelGeo)

    // ── Lamp ───────────────────────────────────────────────────────────────
    const lampMat = new THREE.MeshStandardMaterial({
      color: F.idle,
      emissive: new THREE.Color(F.idle),
      emissiveIntensity: 0.2,
      roughness: 0.3,
    })
    const lamp = new THREE.Mesh(lampGeo, lampMat)
    lamp.position.set(x + facility.width / 2 + 0.42, FRAME_H - 0.5, z + 0.05)
    group.add(lamp)
    disposables.push(lampMat)

    // ── Name plate, hover outline, hitbox ──────────────────────────────────
    const sprite = makeTextSprite(facility.label, { fontSize: 46, worldHeight: 0.72, ...theme.label })
    sprite.position.set(x, board.position.y + BOARD_WORLD_H / 2 + 0.48, z)
    group.add(sprite)
    sprites.push(sprite)

    // Tall enough to take in the board as well as the door: the sign is part of
    // the control, and a pointer travelling down to the shutter should not lose
    // the hover halfway.
    const outlineSize = new THREE.Vector3(
      facility.width + 0.7,
      board.position.y + BOARD_WORLD_H / 2 + 0.1,
      1.9,
    )
    const outlineGeo = new THREE.EdgesGeometry(
      new THREE.BoxGeometry(outlineSize.x, outlineSize.y, outlineSize.z),
    )
    const outlineMat = new THREE.LineBasicMaterial({
      color: theme.highlight,
      transparent: true,
      opacity: 0.9,
    })
    const outline = new THREE.LineSegments(outlineGeo, outlineMat)
    outline.position.set(x, outlineSize.y / 2, z + 0.35)
    outline.renderOrder = 14
    outline.visible = false
    group.add(outline)
    disposables.push(outlineGeo, outlineMat)

    const hitbox = new THREE.Mesh(
      new THREE.BoxGeometry(outlineSize.x, outlineSize.y, outlineSize.z),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    hitbox.position.copy(outline.position)
    hitbox.userData = { kind: 'dock', id: facility.id }
    group.add(hitbox)
    hitboxes.push(hitbox)
    disposables.push(hitbox.geometry, hitbox.material as THREE.Material)

    const door: DoorVisual = {
      id: facility.id,
      label: facility.label,
      facility,
      outlineSize,
      leaf,
      doorMat,
      lampMat,
      board,
      boardTexture,
      boardCanvas,
      outline,
      signature: '',
      flow: 'idle',
      open: 0,
      openTarget: 0,
      pulse: 0,
      active: false,
    }
    doors.push(door)
    byId.set(facility.id, door)
    // Drawn once so a door that is never touched still reads as a closed door
    // with nothing booked against it, rather than a blank sign.
    drawBoard(door, null, theme)
  }

  for (const [geos, mat, cast, receive] of [
    [bumperGeos, rubberMat, true, false],
    [plateGeos, frameMat, false, true],
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

  let hovered: string | null = null

  return {
    group,
    hitboxes,

    sync(states) {
      for (const state of states) {
        const door = byId.get(state.id)
        if (!door) continue

        door.flow = state.flow
        door.active = state.flow !== 'idle'
        door.openTarget = door.active ? 1 : 0

        const color = state.flow === 'inbound' ? F.inbound : state.flow === 'outbound' ? F.outbound : F.idle
        door.lampMat.color.set(color)
        door.lampMat.emissive.set(color)

        const signature = boardSignature(state)
        if (signature !== door.signature) {
          door.signature = signature
          drawBoard(door, state, theme)
        }
      }
    },

    tick(dt) {
      for (const door of doors) {
        if (door.open !== door.openTarget) {
          const step = ROLL_RATE * dt
          door.open =
            door.openTarget > door.open
              ? Math.min(door.openTarget, door.open + step)
              : Math.max(door.openTarget, door.open - step)
          // A shutter never rolls fully into the header — the leaf stacks up.
          door.leaf.scale.y = Math.max(0.001, 1 - door.open * 0.94)
        }

        // A working door's lamp breathes; an idle one is a dim standby glow.
        door.pulse += dt * (door.flow === 'inbound' ? 2.6 : door.flow === 'outbound' ? 1.9 : 0)
        const lift = door.active ? 0.55 + 0.45 * (Math.sin(door.pulse) * 0.5 + 0.5) : 0.16
        door.lampMat.emissiveIntensity = hovered === door.id ? Math.max(lift, 1.1) : lift
        door.doorMat.emissiveIntensity = hovered === door.id ? 0.22 : 0
      }
    },

    setHover(dockId) {
      if (hovered === dockId) return
      hovered = dockId
      for (const door of doors) {
        const on = door.id === dockId
        door.outline.visible = on
        ;(door.outline.material as THREE.LineBasicMaterial).color.set(on ? F.hover : theme.highlight)
      }
    },

    anchorOf(dockId) {
      const door = byId.get(dockId)
      return door ? door.board.position.clone().setY(door.board.position.y + 0.35) : null
    },

    boundsOf(dockId) {
      const door = byId.get(dockId)
      if (!door) return null
      return {
        center: new THREE.Vector3(
          door.facility.pos.x,
          door.outlineSize.y / 2,
          door.facility.pos.y + 0.35,
        ),
        size: door.outlineSize.clone(),
      }
    },

    dispose() {
      for (const sprite of sprites) disposeSprite(sprite)
      for (const item of disposables) item.dispose()
    },
  }
}

/** Only the numbers that are actually drawn — anything else would redraw for nothing. */
function boardSignature(state: DockActivity): string {
  const lines = dockBoardLines(state)
  return `${state.flow}|${lines.primary}|${lines.detail}|${Math.round(state.progress * 60)}`
}

/**
 * Repaint one door's board.
 *
 * Canvas rather than sprites, because the board is a fixed-size sign carrying
 * three different things — a state word, two lines of text and a bar — and
 * drawing it in one pass keeps it aligned at any distance. Called only when
 * {@link boardSignature} changes, so a busy shift repaints a door a handful of
 * times, not sixty times a second.
 */
function drawBoard(
  door: DoorVisual,
  state: DockActivity | null,
  theme: ReturnType<typeof sceneTheme>,
): void {
  const F = theme.dockFlow
  const ctx = door.boardCanvas.getContext('2d')
  if (!ctx) return

  const flow: DockFlow = state?.flow ?? 'idle'
  const accent = hexString(flow === 'inbound' ? F.inbound : flow === 'outbound' ? F.outbound : F.idle)
  const lines = state ? dockBoardLines(state) : { primary: 'No trailer', detail: 'door closed' }

  ctx.clearRect(0, 0, BOARD_W, BOARD_H)
  ctx.fillStyle = F.board
  roundRect(ctx, 2, 2, BOARD_W - 4, BOARD_H - 4, 16)
  ctx.fill()
  ctx.strokeStyle = accent
  ctx.lineWidth = 3
  ctx.stroke()

  // Flow chip: the direction of travel, as a word and as an arrow.
  const chipW = 132
  ctx.fillStyle = accent
  roundRect(ctx, 16, 16, chipW, 40, 10)
  ctx.fill()
  ctx.fillStyle = F.board
  ctx.font = '700 24px Inter, system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(flow === 'inbound' ? '▼ IN' : flow === 'outbound' ? '▲ OUT' : '■ IDLE', 30, 37)

  ctx.fillStyle = F.boardText
  ctx.font = '700 30px Inter, system-ui, sans-serif'
  ctx.fillText(clip(ctx, lines.primary, BOARD_W - chipW - 48), chipW + 32, 37)

  ctx.fillStyle = F.boardMuted
  ctx.font = '500 24px Inter, system-ui, sans-serif'
  ctx.fillText(clip(ctx, lines.detail, BOARD_W - 44), 22, 84)

  // Progress bar: how far through the work at this door, whichever way it flows.
  const barY = 112
  const barW = BOARD_W - 44
  ctx.fillStyle = F.boardMuted
  ctx.globalAlpha = 0.28
  roundRect(ctx, 22, barY, barW, 20, 10)
  ctx.fill()
  ctx.globalAlpha = 1
  const progress = Math.max(0, Math.min(1, state?.progress ?? 0))
  if (progress > 0) {
    ctx.fillStyle = accent
    roundRect(ctx, 22, barY, Math.max(20, barW * progress), 20, 10)
    ctx.fill()
  }

  door.boardTexture.needsUpdate = true
}

/** Trim to the board's width, with an ellipsis, so text never runs off the sign. */
function clip(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  let cut = text
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1)
  return `${cut}…`
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, h / 2, w / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

function hexString(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`
}

function boxAt(x: number, y: number, z: number, w: number, h: number, d: number): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(w, h, d)
  geo.translate(x, y, z)
  return geo
}
