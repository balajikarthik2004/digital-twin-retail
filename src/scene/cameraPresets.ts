import * as THREE from 'three'
import type { WarehouseModel } from '../warehouse/types'

export type CameraPresetId = 'overview' | 'top' | 'aisle' | 'dock'

export interface CameraPreset {
  id: CameraPresetId
  label: string
  hint: string
}

export const CAMERA_PRESETS: CameraPreset[] = [
  { id: 'overview', label: 'Overview', hint: 'Angled hero view of the whole module' },
  { id: 'top', label: 'Top-down', hint: 'Plan view — best for reading pick paths' },
  { id: 'aisle', label: 'Aisle level', hint: 'Operator eye height inside an aisle' },
  { id: 'dock', label: 'Dock view', hint: 'From the outbound dock towards the racks' },
]

export interface CameraPose {
  position: THREE.Vector3
  target: THREE.Vector3
}

/** Compute a framing pose for a preset from the model's real dimensions. */
export function poseFor(preset: CameraPresetId, model: WarehouseModel): CameraPose {
  const { bounds } = model
  const width = bounds.maxX - bounds.minX
  const depth = bounds.maxZ - bounds.minZ
  const centerX = (bounds.minX + bounds.maxX) / 2
  const centerZ = (bounds.minZ + bounds.maxZ) / 2
  const span = Math.max(width, depth)

  switch (preset) {
    case 'top':
      // Nudged a few degrees off vertical on purpose: at an exactly straight-down
      // polar angle the azimuth is undefined and OrbitControls keeps whatever
      // rotation the previous view had, which lands the plan view on a tilt.
      return {
        position: new THREE.Vector3(centerX, span * 1.12, centerZ + span * 0.05),
        target: new THREE.Vector3(centerX, 0, centerZ),
      }

    case 'aisle': {
      // Stand in the middle aisle at the front cross aisle, look down the aisle.
      const aisle = model.aisleX[Math.floor(model.aisleX.length / 2)] ?? centerX
      const z = model.crossZ[0] ?? bounds.minZ
      return {
        position: new THREE.Vector3(aisle, 1.72, z - 1.5),
        target: new THREE.Vector3(aisle, 1.35, bounds.maxZ),
      }
    }

    case 'dock': {
      const dock = model.facilities.find((f) => f.kind === 'dock')
      const x = dock?.pos.x ?? centerX
      return {
        position: new THREE.Vector3(x, 7.5, bounds.minZ - depth * 0.16),
        target: new THREE.Vector3(centerX, 1.5, centerZ + depth * 0.08),
      }
    }

    case 'overview':
    default:
      return {
        position: new THREE.Vector3(centerX + span * 0.3, span * 0.4, bounds.minZ - depth * 0.28),
        target: new THREE.Vector3(centerX, 2, centerZ),
      }
  }
}

/** Critically-damped-ish tween used for preset transitions. */
export class CameraTween {
  private active = false
  private fromPos = new THREE.Vector3()
  private toPos = new THREE.Vector3()
  private fromTarget = new THREE.Vector3()
  private toTarget = new THREE.Vector3()
  private t = 0
  private duration = 0.9

  start(current: CameraPose, next: CameraPose, duration = 0.9): void {
    this.fromPos.copy(current.position)
    this.fromTarget.copy(current.target)
    this.toPos.copy(next.position)
    this.toTarget.copy(next.target)
    this.duration = Math.max(0.05, duration)
    this.t = 0
    this.active = true
  }

  get running(): boolean {
    return this.active
  }

  /** @returns the pose for this frame, or null when idle. */
  update(dt: number): CameraPose | null {
    if (!this.active) return null
    this.t = Math.min(1, this.t + dt / this.duration)
    const e = easeInOutCubic(this.t)
    const pose = {
      position: this.fromPos.clone().lerp(this.toPos, e),
      target: this.fromTarget.clone().lerp(this.toTarget, e),
    }
    if (this.t >= 1) this.active = false
    return pose
  }

  cancel(): void {
    this.active = false
  }
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}
