import * as THREE from 'three'
import type { Vec2 } from '../pathfinding/types'

/**
 * How many metres one flow-texture tile covers along a route. Both the
 * "done" glow and the "still to walk" dashes are cut from the same cloth at
 * this period, so a dash and the glow's cross-fade band read as the same
 * physical scale wherever they appear.
 */
const FLOW_PERIOD_METRES = 0.9

/**
 * Cross-section alpha profile shared by both ribbon variants: transparent at
 * the two edges, full in the middle. This is what turns the ribbon from a
 * hard-edged plastic strip into a soft, anti-aliased line — the single
 * biggest cheap win for making a route read as a rendered line rather than a
 * floor decal.
 */
function paintCrossFade(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const g = ctx.createLinearGradient(0, 0, 0, h)
  g.addColorStop(0, 'rgba(255,255,255,0)')
  g.addColorStop(0.22, 'rgba(255,255,255,0.9)')
  g.addColorStop(0.5, 'rgba(255,255,255,1)')
  g.addColorStop(0.78, 'rgba(255,255,255,0.9)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
}

let cachedSolid: THREE.Texture | null = null
let cachedFlow: THREE.Texture | null = null

/**
 * Soft-edged, unbroken fill — the "already walked" portion of a route. Pure
 * white with an alpha ramp; `material.color` tints it to the picker's colour.
 */
function getSolidTexture(): THREE.Texture {
  if (cachedSolid) return cachedSolid
  const canvas = document.createElement('canvas')
  canvas.width = 8
  canvas.height = 64
  const ctx = canvas.getContext('2d')!
  paintCrossFade(ctx, canvas.width, canvas.height)
  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  cachedSolid = texture
  return texture
}

/**
 * Soft-edged dashes — the "still to walk" portion of a route. One dash-plus-
 * gap cycle per {@link FLOW_PERIOD_METRES} of geometry UV, so `tickRibbonFlow`
 * can scroll every plan ribbon in the building with a single texture-offset
 * write instead of a per-agent update.
 */
function getFlowTexture(): THREE.Texture {
  if (cachedFlow) return cachedFlow
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')!
  paintCrossFade(ctx, canvas.width, canvas.height)
  // Punch the gap out of the cross-fade rather than drawing the dash on top of
  // it, so the dash keeps the same soft vertical edge the solid fill has.
  ctx.globalCompositeOperation = 'destination-in'
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width * 0.58, canvas.height)
  ctx.globalCompositeOperation = 'source-over'
  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  cachedFlow = texture
  return texture
}

/** Scrolls every "still to walk" ribbon in the scene one tick. Call once per frame. */
export function tickRibbonFlow(dt: number): void {
  const t = getFlowTexture()
  // Negative: dashes read as travelling from the picker towards the stop,
  // the direction the polyline's UV.u increases in.
  t.offset.x -= dt * 0.6
}

export type RibbonVariant = 'solid' | 'flow'

/**
 * Flat floor ribbon used for path trails.
 *
 * `LineBasicMaterial.linewidth` is ignored by WebGL on virtually every
 * platform, so a real (thick, mitre-free) path line is drawn as a two-triangle
 * strip laid on the floor. Buffers are preallocated once and only `drawRange`
 * changes as the picker advances, so per-frame cost stays flat.
 *
 * The strip carries a soft-edged alpha texture rather than a flat opaque
 * fill (see {@link getSolidTexture}/{@link getFlowTexture}) so it reads as an
 * anti-aliased line instead of a floor decal; the `flow` variant additionally
 * animates via the shared texture's scrolling offset (`tickRibbonFlow`), so
 * the un-walked part of a route visibly marches towards its destination.
 */
export class PathRibbon {
  readonly mesh: THREE.Mesh
  private position: THREE.BufferAttribute
  private uv: THREE.BufferAttribute
  private geometry: THREE.BufferGeometry
  private readonly maxPoints: number

  constructor(
    color: THREE.ColorRepresentation,
    private width: number,
    maxPoints = 512,
    opacity = 1,
    variant: RibbonVariant = 'solid',
  ) {
    this.maxPoints = maxPoints
    this.geometry = new THREE.BufferGeometry()
    this.position = new THREE.BufferAttribute(new Float32Array(maxPoints * 2 * 3), 3)
    this.position.setUsage(THREE.DynamicDrawUsage)
    this.geometry.setAttribute('position', this.position)
    this.uv = new THREE.BufferAttribute(new Float32Array(maxPoints * 2 * 2), 2)
    this.uv.setUsage(THREE.DynamicDrawUsage)
    this.geometry.setAttribute('uv', this.uv)

    // Two triangles per segment: (2i, 2i+1, 2i+2) and (2i+1, 2i+3, 2i+2).
    const index = new Uint32Array((maxPoints - 1) * 6)
    for (let i = 0; i < maxPoints - 1; i++) {
      const o = i * 6
      const v = i * 2
      index[o] = v
      index[o + 1] = v + 1
      index[o + 2] = v + 2
      index[o + 3] = v + 1
      index[o + 4] = v + 3
      index[o + 5] = v + 2
    }
    this.geometry.setIndex(new THREE.BufferAttribute(index, 1))
    this.geometry.setDrawRange(0, 0)

    this.mesh = new THREE.Mesh(
      this.geometry,
      new THREE.MeshBasicMaterial({
        color,
        map: variant === 'flow' ? getFlowTexture() : getSolidTexture(),
        transparent: true,
        opacity,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    )
    this.mesh.renderOrder = 4
    this.mesh.frustumCulled = false
    this.mesh.visible = false
  }

  setColor(color: THREE.ColorRepresentation): void {
    ;(this.mesh.material as THREE.MeshBasicMaterial).color.set(color)
  }

  setOpacity(opacity: number): void {
    ;(this.mesh.material as THREE.MeshBasicMaterial).opacity = opacity
  }

  /** Replace the ribbon path. `points` are floor coords; `y` is the height. */
  setPath(points: Vec2[], y: number): void {
    const n = Math.min(points.length, this.maxPoints)
    if (n < 2) {
      this.geometry.setDrawRange(0, 0)
      this.mesh.visible = false
      return
    }

    const arr = this.position.array as Float32Array
    const uv = this.uv.array as Float32Array
    const half = this.width / 2
    let arc = 0

    for (let i = 0; i < n; i++) {
      const prev = points[Math.max(0, i - 1)]
      const next = points[Math.min(n - 1, i + 1)]
      let tx = next.x - prev.x
      let tz = next.y - prev.y
      const len = Math.hypot(tx, tz) || 1
      tx /= len
      tz /= len
      // Left normal in the floor plane.
      const nx = -tz * half
      const nz = tx * half

      if (i > 0) arc += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
      // Real-world metres, not a 0-1 fraction: a short and a long route then
      // carry the same dash spacing instead of the long one stretching thin.
      const u = arc / FLOW_PERIOD_METRES

      const p = points[i]
      const o = i * 6
      arr[o] = p.x + nx
      arr[o + 1] = y
      arr[o + 2] = p.y + nz
      arr[o + 3] = p.x - nx
      arr[o + 4] = y
      arr[o + 5] = p.y - nz

      const uo = i * 4
      uv[uo] = u
      uv[uo + 1] = 0
      uv[uo + 2] = u
      uv[uo + 3] = 1
    }

    this.position.needsUpdate = true
    this.uv.needsUpdate = true
    this.geometry.setDrawRange(0, (n - 1) * 6)
    this.geometry.computeBoundingSphere()
    this.mesh.visible = true
  }

  hide(): void {
    this.mesh.visible = false
  }

  /**
   * Material only, not `.map` — the cross-fade/flow texture is a shared
   * singleton every ribbon points at, and `Material.dispose()` never touches
   * a texture assigned to it, so this is already safe to call unconditionally.
   */
  dispose(): void {
    this.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
  }
}

/**
 * Resample a polyline so it only covers `[0, arc]` — used to draw the portion
 * of the route a picker has already walked.
 */
export function polylineUpTo(points: Vec2[], cumulative: number[], arc: number): Vec2[] {
  if (points.length === 0) return []
  const out: Vec2[] = [points[0]]
  for (let i = 1; i < points.length; i++) {
    if (cumulative[i] <= arc) {
      out.push(points[i])
      continue
    }
    const segLen = cumulative[i] - cumulative[i - 1]
    const t = segLen > 1e-6 ? (arc - cumulative[i - 1]) / segLen : 0
    if (t > 1e-4) {
      out.push({
        x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
        y: points[i - 1].y + (points[i].y - points[i - 1].y) * t,
      })
    }
    break
  }
  return out
}
