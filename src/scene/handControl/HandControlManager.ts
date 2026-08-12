import type { NormalizedLandmark } from '@mediapipe/tasks-vision'
import { HandShapeTracker, pinchRatio } from './GestureDetector'
import { NavigationController } from './NavigationController'
import { LandmarkSmoother } from './smoothing'
import {
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
 * The central `handleGesture()` of the feature: every tracked frame, turns up
 * to two hands' shapes into exactly one active control channel, in a fixed
 * priority, so the gestures can never conflict — and every one of them is a
 * one-hand gesture, mirroring how you'd zoom, scroll and... well, rotate
 * isn't quite a phone gesture, but pinch-zoom and two-finger-drag are, and
 * that's the point: this should feel familiar on first try, not learned —
 *
 * ```
 * 1. Thumb + index extended   zoom  (spread the tips apart -> in, together -> out)
 * 2. Index + middle together  pan   (drag the hand to steer, release to stop)
 * 3. A closed fist            rotate (fixed slow spin, open the hand to stop)
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
 * identity sidesteps the question entirely. It also means a second hand in
 * frame is never required — every gesture here resolves off a single hand's
 * shape, the first one found wearing it.
 */
export class HandControlManager {
  private smoothers = [new LandmarkSmoother(), new LandmarkSmoother()]
  private shapeTrackers = [new HandShapeTracker(), new HandShapeTracker()]
  private nav = new NavigationController()
  private rotateNav = new NavigationController()
  private zoomCtrl = new ZoomController()
  private sensitivity = 1

  setSensitivity(v: number): void {
    this.sensitivity = v
  }

  reset(): void {
    this.smoothers.forEach((s) => s.reset())
    this.shapeTrackers.forEach((t) => t.reset())
    this.nav.disengage()
    this.rotateNav.disengage()
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

    // Priority 1 — zoom: require the 'point' shape (index extended, others curled).
    // This acts as a clutch: to stop zooming, simply open your hand naturally
    // (which breaks the 'point' shape) and the camera will instantly freeze.
    const zoomHand = hands.find((h) => h.shape === 'point')
    if (zoomHand) {
      this.nav.disengage()
      this.rotateNav.disengage()
      const zoom = this.zoomCtrl.drive(zoomHand.pinch) * this.sensitivity
      const message = zoom > 0 ? 'Zooming in' : zoom < 0 ? 'Zooming out' : 'Thumb + index to zoom'
      return this.finish('zoom', message, hands, [zoomHand], { pan: ZERO_AXES, orbitYaw: 0, orbitPitch: 0, zoom })
    }
    this.zoomCtrl.reset()

    // Priority 2 — index + middle held together: pan, like a two-finger drag
    // on a touchpad or phone screen.
    const panHand = hands.find((h) => h.shape === 'twoFinger')
    if (panHand) {
      this.rotateNav.disengage()
      this.nav.engage(panHand.point)
      const pan = this.nav.drive(panHand.point, this.sensitivity)
      return this.finish('pan', 'Panning — release to stop', hands, [panHand], {
        pan,
        orbitYaw: 0,
        orbitPitch: 0,
        zoom: 0,
      })
    }
    this.nav.disengage()

    // Priority 3 — a closed fist: grab to rotate.
    // Like panning, it uses the navigation controller to track hand displacement,
    // but feeds those axes to the camera's rotation channels instead of panning.
    const fisted = hands.find((h) => h.shape === 'fist')
    if (fisted) {
      this.rotateNav.engage(fisted.point)
      const drag = this.rotateNav.drive(fisted.point, this.sensitivity)
      return this.finish('rotate', 'Grabbed — drag to rotate', hands, [fisted], {
        pan: ZERO_AXES,
        // Scale drag by 3.0 to make it responsive for rotation
        orbitYaw: drag.right * 3.0,
        orbitPitch: drag.up * -3.0,
        zoom: 0,
      })
    }
    this.rotateNav.disengage()

    return this.finish(
      'idle',
      'Thumb+index to zoom · index+middle to pan · fist to rotate',
      hands,
      [],
      ZERO_INTENT,
    )
  }

  private readHand(landmarks: NormalizedLandmark[], slot: number): HandReading {
    const smoothed = this.smoothers[slot].smooth(landmarks)
    const shape = this.shapeTrackers[slot].classify(smoothed)
    const pinch = pinchRatio(smoothed)

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
    return { point: { x: 1 - rawX, y: rawY }, rawX, rawY, shape, pinch }
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
