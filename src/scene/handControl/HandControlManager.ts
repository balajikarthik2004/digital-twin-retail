import type { NormalizedLandmark } from '@mediapipe/tasks-vision'
import { calculateHandDistance, HandShapeTracker } from './GestureDetector'
import { NavigationController } from './NavigationController'
import { LandmarkSmoother } from './smoothing'
import {
  clamp,
  HAND_CONTROL_IDLE,
  ZERO_AXES,
  ZERO_INTENT,
  type HandControlMode,
  type HandControlSnapshot,
  type HandDriveIntent,
  type HandPoint,
  type HandReading,
} from './types'
import { ZoomController } from './ZoomController'

/**
 * Fixed yaw rate while a fist is held — deliberately *not* proportional to
 * hand position or velocity. An earlier version drove rotate from how fast
 * two open hands were drifting sideways, which is nearly impossible for a
 * human to hold at exactly zero: any residual tracking noise read as the
 * camera "continuing to spin on its own," and there was no clear on-screen
 * "home" position to return to, to know it had actually stopped. A flat rate
 * that starts the instant a fist closes and stops the instant it opens has
 * neither problem — the only state is "is the hand a fist," which is exactly
 * as binary as the fix needs it to be.
 */
const ROTATE_SPEED = 0.35

/**
 * The central `handleGesture()` of the feature: every tracked frame, turns up
 * to two hands' shapes into exactly one active control channel, in a fixed
 * priority, so the three gestures can never conflict —
 *
 * ```
 * 1. Both hands pinched   zoom  (spread apart -> in, together -> out)
 * 2. One hand pinched     pan   (move to steer, release to stop)
 * 3. A closed fist         rotate (fixed slow spin, open the hand to stop)
 * ```
 *
 * Deliberately **hand-agnostic** — it is the *shape* a hand is making that
 * decides what happens, never which physical hand (left/right) is making it.
 * A previous version keyed navigation off MediaPipe's own left/right
 * classification, which assumes the frame handed to the model is itself
 * mirrored (selfie-style); ours isn't (only the `<video>` preview is, in
 * CSS), so trusting it needs an inversion that is trivial to get backwards —
 * and getting it backwards silently swaps which hand drives what, which reads
 * exactly like "the camera moved on its own." Reading shape instead of
 * identity sidesteps the question entirely.
 */
export class HandControlManager {
  private smoothers = [new LandmarkSmoother(), new LandmarkSmoother()]
  private shapeTrackers = [new HandShapeTracker(), new HandShapeTracker()]
  private nav = new NavigationController()
  private zoomCtrl = new ZoomController()
  private sensitivity = 1

  setSensitivity(v: number): void {
    this.sensitivity = v
  }

  reset(): void {
    this.smoothers.forEach((s) => s.reset())
    this.shapeTrackers.forEach((t) => t.reset())
    this.nav.disengage()
    this.zoomCtrl.reset()
  }

  /** One tracked video frame in, one fully-resolved control decision out. */
  handleGesture(rawHands: NormalizedLandmark[][]): { snapshot: HandControlSnapshot; intent: HandDriveIntent } {
    if (rawHands.length === 0) {
      this.reset()
      return {
        snapshot: { ...HAND_CONTROL_IDLE, status: 'no-hand', message: 'Show a hand to the camera.' },
        intent: ZERO_INTENT,
      }
    }

    const hands = rawHands.slice(0, 2).map((landmarks, i) => this.readHand(landmarks, i))
    // A hand slot that went unused this frame (two hands -> one) would otherwise
    // keep stale hysteresis and could resume its old shape the instant it returns.
    for (let i = hands.length; i < 2; i++) {
      this.smoothers[i].reset()
      this.shapeTrackers[i].reset()
    }

    const pinched = hands.filter((h) => h.shape === 'pinch')

    // Priority 1 — both hands pinched: zoom. The only gesture that needs both
    // hands committed at once, so it wins over a lone pinch trying to pan.
    if (pinched.length >= 2) {
      this.nav.disengage()
      const distance = calculateHandDistance(pinched[0], pinched[1])
      const zoom = clamp(this.zoomCtrl.drive(distance) * this.sensitivity, -1, 1)
      const message = zoom > 0 ? 'Zooming in' : zoom < 0 ? 'Zooming out' : 'Zoom — spread or pinch your hands'
      return this.finish('zoom', message, hands, pinched, { pan: ZERO_AXES, orbitYaw: 0, orbitPitch: 0, zoom })
    }
    this.zoomCtrl.reset()

    // Priority 2 — one hand pinched: pan.
    if (pinched.length === 1) {
      const hand = pinched[0]
      this.nav.engage(hand.point)
      const pan = this.nav.drive(hand.point, this.sensitivity)
      return this.finish('pan', 'Panning — release the pinch to stop', hands, [hand], {
        pan,
        orbitYaw: 0,
        orbitPitch: 0,
        zoom: 0,
      })
    }
    this.nav.disengage()

    // Priority 3 — a closed fist: rotate, fixed slow spin, until it opens.
    const fisted = hands.find((h) => h.shape === 'fist')
    if (fisted) {
      return this.finish('rotate', 'Rotating — open your hand to stop', hands, [fisted], {
        pan: ZERO_AXES,
        orbitYaw: ROTATE_SPEED * this.sensitivity,
        orbitPitch: 0,
        zoom: 0,
      })
    }

    return this.finish(
      'idle',
      'Pinch to pan · make a fist to rotate · pinch with both hands to zoom',
      hands,
      [],
      ZERO_INTENT,
    )
  }

  private readHand(landmarks: NormalizedLandmark[], slot: number): HandReading {
    const smoothed = this.smoothers[slot].smooth(landmarks)
    const shape = this.shapeTrackers[slot].classify(smoothed)

    let sumX = 0
    let sumY = 0
    for (const p of smoothed) {
      sumX += p.x
      sumY += p.y
    }
    const rawX = sumX / smoothed.length
    const rawY = sumY / smoothed.length

    // The preview is mirrored (CSS `scaleX(-1)`) so the feed reads like a
    // mirror; MediaPipe's coordinates are not, so the mirrored position is
    // `1 - raw`.
    return { point: { x: 1 - rawX, y: rawY }, rawX, rawY, shape }
  }

  private finish(
    mode: HandControlMode,
    message: string,
    hands: HandReading[],
    active: HandReading[],
    intent: HandDriveIntent,
  ): { snapshot: HandControlSnapshot; intent: HandDriveIntent } {
    const points: HandPoint[] = hands.map((h) => ({
      x: h.point.x,
      y: h.point.y,
      shape: h.shape,
      active: active.includes(h),
    }))
    return { snapshot: { status: 'tracking', message, mode, hands: points }, intent }
  }
}
