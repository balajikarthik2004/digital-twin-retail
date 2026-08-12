import type { MoveAxes } from '../WarehouseScene'
import { NavigationController } from './NavigationController'
import { clamp } from './types'

/**
 * Pinch-and-hold to rotate: touch thumb and index tip together anywhere in
 * frame, hold that pinch for {@link PINCH_ARM_MS}, and the camera hands itself
 * over to you — from then on, for as long as the pinch stays shut, moving your
 * hand orbits the warehouse, all the way round and round if you keep going.
 * Open the fingers and it stops instantly.
 *
 * The two-second hold is the whole point of the gesture, not a formality. A
 * shut pinch is the *bottom* of the zoom gesture's range (thumb and index all
 * the way together — see {@link ZoomController}), so the two would otherwise
 * fight over the same hand pose. The dwell separates them in time instead of
 * in space: a pinch that closes and reopens is a zoom-out, a pinch that closes
 * and *stays* closed is a request to rotate. Nothing moves during the dwell —
 * the manager suppresses zoom for a hand that is pinched shut — so the two
 * seconds read as a deliberate "grab," not as a lag.
 *
 * Once armed, the hand's *shape* stops being consulted (only the pinch
 * distance is) — a hand held pinched for a while drifts through shapes the
 * classifier reads differently, and losing rotate mid-turn because three idle
 * fingers curled is exactly the "the camera got away from me" failure this
 * feature exists to avoid.
 */

/** Palm-normalized thumb-to-index-tip distance (see `pinchRatio`) at or under
 *  which the fingers count as pinched shut. Generous — it has to survive being
 *  held for two seconds, and a pinch this deliberate has no competition down
 *  here. */
export const PINCH_CLOSED = 0.45
/** ...and the distance an *established* pinch has to open back out to before it
 *  counts as released. The gap between the two is hysteresis: without it, a
 *  hand resting right at the threshold would drop and re-arm rotate on
 *  alternating frames. */
export const PINCH_RELEASED = 0.62
/** How long the pinch has to be held before it takes the camera over. */
export const PINCH_ARM_MS = 2000

/**
 * Rotate is a held *rate*, not a delta: how far the hand sits from where it
 * armed sets how fast the view turns, and it keeps turning while the hand
 * stays there — which is what lets a small hand movement carry a full 360°
 * (and past it; yaw is unbounded) without the hand ever leaving frame.
 *
 * The rate is clamped before this scale is applied, so the sensitivity slider
 * changes how little hand travel reaches full speed but can never raise the
 * ceiling — the fastest a hand can spin the camera is a fixed, walkable speed.
 */
export const ROTATE_DRAG_SCALE = 2.5

/** `off` — not pinched. `arming` — pinched, still counting down. `armed` — the
 *  hand owns the camera's rotation. */
export type PinchPhase = 'off' | 'arming' | 'armed'

export interface OrbitDrag {
  yaw: number
  pitch: number
}

export const ZERO_ORBIT: OrbitDrag = { yaw: 0, pitch: 0 }

/**
 * The one place a relative hand drag becomes orbit rates, shared by both
 * rotate gestures (pinch-hold and fist) so they turn the camera identically —
 * two rotate gestures that disagree about which way is up is a bug you feel
 * without being able to name.
 *
 * Directions match a mouse drag in `OrbitControls`: hand right turns the view
 * the way dragging right does, hand down tips the camera up over the top.
 */
export function orbitFromDrag(drag: MoveAxes): OrbitDrag {
  return {
    // `|| 0` normalizes the -0 that negating a zeroed axis produces, so "not
    // turning" is one value everywhere downstream rather than two.
    yaw: clamp(drag.right, -1, 1) * ROTATE_DRAG_SCALE || 0,
    pitch: clamp(-drag.up, -1, 1) * ROTATE_DRAG_SCALE || 0,
  }
}

export class PinchRotateController {
  /** Relative-drag math, dead zone and easing, shared with pan — rotate is the
   *  same "how far from where you started" reading, pointed at a different
   *  channel. */
  private nav = new NavigationController()
  private closedSince: number | null = null
  private armed = false
  private heldMs = 0

  get phase(): PinchPhase {
    if (this.armed) return 'armed'
    return this.closedSince === null ? 'off' : 'arming'
  }

  /** 0–1 through the arming dwell — what the panel draws as a filling bar. */
  get progress(): number {
    return this.armed ? 1 : clamp(this.heldMs / PINCH_ARM_MS, 0, 1)
  }

  /** Milliseconds of hold still to go, for the countdown copy. */
  get remainingMs(): number {
    return this.armed ? 0 : Math.max(0, PINCH_ARM_MS - this.heldMs)
  }

  /**
   * One frame of pinch state in, the resolved phase out.
   *
   * `canArm` is the caller's shape gate — which hand poses are allowed to
   * *start* a pinch-hold at all (a fist, for instance, is not: it has its own
   * rotate gesture, and its curled thumb can read as a pinch, so letting it
   * arm here would hand the same turn to two controllers two seconds in). It
   * deliberately has no say once armed.
   */
  update(now: number, pinch: number, point: { x: number; y: number }, canArm: boolean): PinchPhase {
    const established = this.closedSince !== null
    const closed = established ? pinch < PINCH_RELEASED : pinch <= PINCH_CLOSED

    if (!closed || (!canArm && !this.armed)) {
      this.reset()
      return 'off'
    }

    if (this.closedSince === null) this.closedSince = now
    this.heldMs = Math.max(0, now - this.closedSince)

    if (!this.armed && this.heldMs >= PINCH_ARM_MS) {
      this.armed = true
      // Reference captured at the instant it arms, not when the pinch closed,
      // so the camera starts from rest wherever the hand happens to be.
      this.nav.engage(point)
    }

    return this.phase
  }

  /** Orbit rates for the current hand position — all zero until armed. */
  drive(point: { x: number; y: number }, sensitivity: number): OrbitDrag {
    if (!this.armed) return { ...ZERO_ORBIT }
    return orbitFromDrag(this.nav.drive(point, sensitivity))
  }

  reset(): void {
    this.closedSince = null
    this.armed = false
    this.heldMs = 0
    this.nav.disengage()
  }
}
