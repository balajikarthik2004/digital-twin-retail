import type { NormalizedLandmark } from '@mediapipe/tasks-vision'
import { HandShapeTracker, pinchRatio } from './GestureDetector'
import { NavigationController } from './NavigationController'
import { orbitFromDrag, PinchRotateController, type PinchPhase } from './PinchRotateController'
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
 * 1. Pinch held shut 2s       rotate (then drag to turn, 360° and past it)
 * 2. Thumb + index extended   zoom  (spread the tips apart -> in, together -> out)
 * 3. Index + middle together  pan   (drag the hand to steer, release to stop)
 * 4. A closed fist            rotate (drag to turn, open the hand to stop)
 * ```
 *
 * **Exactly one channel is live per frame, always.** The priority above is a
 * total order over hands *and* gestures: the winning branch drives its channel,
 * zeroes the others in the returned intent, and every controller it didn't pick
 * is disengaged on the way past — so no controller can hold a stale reference
 * and no two can drive the camera in the same frame. The one pair that could
 * genuinely collide is pinch-hold rotate and zoom, which share a hand pose
 * (a shut pinch is the closed end of zoom's range): they are separated by the
 * two-second dwell, and a hand pinched shut has its zoom output suppressed for
 * as long as it stays shut, so the camera never zooms and rotates at once, and
 * never zooms while you are waiting out the hold.
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
  /** One per hand slot, so a second hand in frame can never inherit the first
   *  one's dwell timer or its rotate reference. */
  private pinchRotators = [new PinchRotateController(), new PinchRotateController()]
  private sensitivity = 1

  setSensitivity(v: number): void {
    this.sensitivity = v
  }

  reset(): void {
    this.smoothers.forEach((s) => s.reset())
    this.shapeTrackers.forEach((t) => t.reset())
    this.pinchRotators.forEach((p) => p.reset())
    this.nav.disengage()
    this.rotateNav.disengage()
    this.zoomCtrl.reset()
  }

  /**
   * One tracked video frame in, one fully-resolved control decision out.
   *
   * `now` is the frame's own timestamp (`performance.now()`, the same clock
   * handed to the tracker), passed in rather than read here so the timed
   * pinch-hold is a pure function of its inputs and testable without a clock.
   */
  handleGesture(
    rawHands: NormalizedLandmark[][],
    now: number,
  ): { snapshot: HandControlSnapshot; intent: HandDriveIntent } {
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
      this.pinchRotators[i].reset()
    }

    // Advance every hand's pinch-hold clock first — the winning gesture is
    // chosen from the resolved phases below, so the decision reads in one place.
    //
    // A hand may only *start* a hold from the shapes that have no rotate of
    // their own: 'point' (the zoom hand, whose pinch is the point of this
    // gesture) and 'other' (a hand mid-pinch that matches nothing cleanly).
    // A fist is excluded on purpose — its curled thumb can measure as a pinch,
    // and if it could arm here, holding a fist for two seconds would hand the
    // same turn to two controllers and snap the view as the reference reset.
    const phases: PinchPhase[] = hands.map((h, i) =>
      this.pinchRotators[i].update(
        now,
        h.pinch,
        h.point,
        h.shape === 'point' || h.shape === 'other',
      ),
    )

    // Priority 1 — a pinch held shut past the dwell: drag to rotate, freely
    // past a full turn. First armed hand wins and any other is stood down, so
    // two pinched hands can never fight over the same camera.
    const rotateSlot = phases.indexOf('armed')
    if (rotateSlot >= 0) {
      this.pinchRotators.forEach((p, i) => {
        if (i !== rotateSlot) p.reset()
      })
      this.nav.disengage()
      this.rotateNav.disengage()
      this.zoomCtrl.reset()
      const hand = hands[rotateSlot]
      const orbit = this.pinchRotators[rotateSlot].drive(hand.point, this.sensitivity)
      const turning = orbit.yaw !== 0 || orbit.pitch !== 0
      return this.finish(
        'rotate',
        turning ? 'Rotating — move back to centre to stop' : 'Pinch held — move your hand to turn',
        hands,
        [hand],
        { pan: ZERO_AXES, orbitYaw: orbit.yaw, orbitPitch: orbit.pitch, zoom: 0 },
        1,
      )
    }

    // Priority 2 — zoom: require the 'point' shape (index extended, others curled).
    // This acts as a clutch: to stop zooming, simply open your hand naturally
    // (which breaks the 'point' shape) and the camera will instantly freeze.
    //
    // A hand that is pinched shut is skipped ('arming', not 'off'): the closed
    // end of the pinch range belongs to the rotate hold, so zoom drives across
    // the open range only. That is what keeps the two from cancelling each
    // other — waiting out the two seconds never dollies the camera.
    const zoomSlot = hands.findIndex((h, i) => h.shape === 'point' && phases[i] === 'off')
    if (zoomSlot >= 0) {
      this.nav.disengage()
      this.rotateNav.disengage()
      const hand = hands[zoomSlot]
      const zoom = this.zoomCtrl.drive(hand.pinch) * this.sensitivity
      const message = zoom > 0 ? 'Zooming in' : zoom < 0 ? 'Zooming out' : 'Thumb + index to zoom'
      return this.finish('zoom', message, hands, [hand], {
        pan: ZERO_AXES,
        orbitYaw: 0,
        orbitPitch: 0,
        zoom,
      })
    }
    this.zoomCtrl.reset()

    // Priority 3 — index + middle held together: pan, like a two-finger drag
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

    // Priority 4 — a closed fist: grab to rotate, no hold needed. Same drag
    // reading as panning, mapped to the orbit channels through the same
    // `orbitFromDrag` the pinch hold uses, so both rotates turn identically.
    const fisted = hands.find((h) => h.shape === 'fist')
    if (fisted) {
      this.rotateNav.engage(fisted.point)
      const orbit = orbitFromDrag(this.rotateNav.drive(fisted.point, this.sensitivity))
      return this.finish('rotate', 'Grabbed — drag to rotate', hands, [fisted], {
        pan: ZERO_AXES,
        orbitYaw: orbit.yaw,
        orbitPitch: orbit.pitch,
        zoom: 0,
      })
    }
    this.rotateNav.disengage()

    // Nothing is driving. If a pinch is mid-hold, say how much is left — a
    // silent two-second wait reads as the tracker having lost the hand.
    const armingSlot = phases.indexOf('arming')
    if (armingSlot >= 0) {
      const rotator = this.pinchRotators[armingSlot]
      const seconds = (rotator.remainingMs / 1000).toFixed(1)
      return this.finish(
        'idle',
        `Hold the pinch — rotate in ${seconds}s`,
        hands,
        [hands[armingSlot]],
        ZERO_INTENT,
        rotator.progress,
      )
    }

    return this.finish(
      'idle',
      'Pinch and hold 2s to rotate · thumb+index to zoom · index+middle to pan',
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
    armProgress = 0,
  ): { snapshot: HandControlSnapshot; intent: HandDriveIntent } {
    const points: HandPoint[] = hands.map((h) => ({
      x: h.point.x,
      y: h.point.y,
      shape: h.shape,
      active: active.includes(h),
    }))
    return { snapshot: { status: 'tracking', message, mode, hands: points, armProgress }, intent }
  }
}
