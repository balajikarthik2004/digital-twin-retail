import * as THREE from 'three'
import type { Vec2 } from '../pathfinding/types'

/**
 * Flat floor ribbon used for path trails.
 *
 * `LineBasicMaterial.linewidth` is ignored by WebGL on virtually every
 * platform, so a real (thick, mitre-free) path line is drawn as a two-triangle
 * strip laid on the floor. Buffers are preallocated once and only `drawRange`
 * changes as the picker advances, so per-frame cost stays flat.
 */
export class PathRibbon {
  readonly mesh: THREE.Mesh
  private position: THREE.BufferAttribute
  private geometry: THREE.BufferGeometry
  private readonly maxPoints: number

  constructor(color: THREE.ColorRepresentation, private width: number, maxPoints = 512, opacity = 1) {
    this.maxPoints = maxPoints
    this.geometry = new THREE.BufferGeometry()
    this.position = new THREE.BufferAttribute(new Float32Array(maxPoints * 2 * 3), 3)
    this.position.setUsage(THREE.DynamicDrawUsage)
    this.geometry.setAttribute('position', this.position)

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
    const half = this.width / 2

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

      const p = points[i]
      const o = i * 6
      arr[o] = p.x + nx
      arr[o + 1] = y
      arr[o + 2] = p.y + nz
      arr[o + 3] = p.x - nx
      arr[o + 4] = y
      arr[o + 5] = p.y - nz
    }

    this.position.needsUpdate = true
    this.geometry.setDrawRange(0, (n - 1) * 6)
    this.geometry.computeBoundingSphere()
    this.mesh.visible = true
  }

  hide(): void {
    this.mesh.visible = false
  }

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
