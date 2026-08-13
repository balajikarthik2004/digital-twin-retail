import type { MoveAxes } from '../WarehouseScene'
import { clamp, ZERO_AXES } from './types'

/**
 * Two-finger-drag navigation: hold index and middle together (like a
 * two-finger swipe on a phone or touchpad) and move your hand — left/right
 * pans the view, up/down elevates it. Feeds the same {@link MoveAxes} channel
 * the on-screen pad already drives (`WarehouseScene.setPadAxes`), so no
 * camera-drive code changes to add this.
 *
 * Movement is *relative to where the hand was when navigation last engaged*,
 * not to the centre of the webcam frame — see {@link engage}. That is what
 * stops the camera jumping the instant you make the two-finger shape: the
 * very first reading is always its own reference, so its own delta is zero.
 */

/** Ignore hand drift under this fraction of the frame — a "dead zone" so
 *  a hand held nearly still never dribbles the camera. */
export const DEAD_ZONE = 0.05
/** Fraction of the frame the hand has to travel from its reference point to
 *  reach full-speed pan/elevate. */
export const MAX_REACH = 0.3
/** Master multiplier for hand-driven pan/elevate, exposed to the user as the
 *  panel's "Sensitivity" slider (0.5–2×). */
export const MOVEMENT_SENSITIVITY = 1

function axisFrom(raw: number): number {
  const magnitude = Math.abs(raw)
  if (magnitude < DEAD_ZONE) return 0
  const t = clamp((magnitude - DEAD_ZONE) / (MAX_REACH - DEAD_ZONE), 0, 1)
  // Smoothstep rather than a straight line. A linear ramp leaves the camera at
  // its twitchiest right where the hand is least steady — just past the dead
  // zone, where residual tracking noise is the same size as the signal. Easing
  // in gives fine control for small deliberate moves and eases out again so
  // reaching full speed doesn't hit a corner.
  const eased = t * t * (3 - 2 * t)
  return Math.sign(raw) * eased
}

export class NavigationController {
  private reference: { x: number; y: number } | null = null

  get engaged(): boolean {
    return this.reference !== null
  }

  /** Called every frame a hand reads as the two-finger shape. Only the first
   *  call after {@link disengage} actually captures a reference — later calls
   *  in the same engagement are no-ops, so the reference never drifts. */
  engage(point: { x: number; y: number }): void {
    if (!this.reference) this.reference = { ...point }
  }

  /** Called the instant the hand stops making the two-finger shape (closed,
   *  lowered, lost, or superseded by a higher-priority gesture). */
  disengage(): void {
    this.reference = null
  }

  /** Pan/elevate axes for the current hand position, or all-zero if not engaged. */
  drive(point: { x: number; y: number }, sensitivity: number): MoveAxes {
    if (!this.reference) return { ...ZERO_AXES }
    const dx = point.x - this.reference.x
    const dy = point.y - this.reference.y
    const s = sensitivity * MOVEMENT_SENSITIVITY
    return {
      forward: 0,
      right: clamp(axisFrom(dx) * s, -1, 1),
      // Screen y grows downward; hand up (dy < 0) should raise the view.
      up: clamp(axisFrom(-dy) * s, -1, 1),
      sprint: false,
    }
  }
}
