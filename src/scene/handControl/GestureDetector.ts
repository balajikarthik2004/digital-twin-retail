import type { NormalizedLandmark } from '@mediapipe/tasks-vision'
import { distance, type HandShape } from './types'

/**
 * Turns one hand's 21 smoothed landmarks into a shape: `fist`, `point`,
 * `twoFinger`, `open`, or `other`. Stateless one-shot detector functions are
 * exported for reuse/testing; the pipeline itself goes through
 * {@link HandShapeTracker}, which adds hysteresis so a shape doesn't flicker
 * right at its threshold — the single biggest source of "the camera twitched
 * for no reason" bug reports in gesture UIs.
 */

/** Landmark indices, MediaPipe's Hand model. */
const WRIST = 0
const THUMB_MCP = 2
const THUMB_IP = 3
const THUMB_TIP = 4
const INDEX_MCP = 5
const INDEX_PIP = 6
const INDEX_TIP = 8
const MIDDLE_MCP = 9
const MIDDLE_PIP = 10
const MIDDLE_TIP = 12
const RING_MCP = 13
const RING_PIP = 14
const RING_TIP = 16
const PINKY_MCP = 17
const PINKY_PIP = 18
const PINKY_TIP = 20

/** Below this bend angle (degrees) a finger counts as curled; at or above it,
 *  extended. A dead-straight finger measures close to 180°; a fully curled
 *  one well under 90°. 150° leaves room for a finger that doesn't fully
 *  straighten (common for ring/pinky on a real hand) while still rejecting a
 *  relaxed, half-open one. */
const FINGER_CURL_ANGLE = 150
/** The thumb's IP joint sits with more natural bend than the other fingers'
 *  PIP even when the thumb reads as "extended" (anatomy, not tracking noise),
 *  so it needs its own, lower bar to count as curled. */
const THUMB_CURL_ANGLE = 140

interface FingerCurl {
  thumb: boolean
  index: boolean
  middle: boolean
  ring: boolean
  pinky: boolean
}

function palmSize(landmarks: NormalizedLandmark[]): number {
  return Math.max(distance(landmarks[WRIST], landmarks[MIDDLE_MCP]), 0.02)
}

/**
 * The bend angle at a finger's middle joint (PIP for the four fingers, IP
 * for the thumb), in degrees — the angle between the MCP→joint and
 * joint→tip vectors. ~180° is dead straight; the more a finger curls toward
 * the palm, the smaller this gets.
 *
 * This is what makes curl detection hold up regardless of how the hand is
 * angled to the camera, unlike comparing tip-to-wrist distance (the
 * previous approach here): a straight finger pointed *at* the camera
 * foreshortens and can measure "closer to the wrist" than a curled one
 * angled across the frame, misreading as curled. A joint's own bend doesn't
 * care which way the hand is turned — it uses all three spatial axes
 * (MediaPipe landmarks carry a relative-depth `z`, not just `x`/`y`), so
 * tilting or rolling the hand changes the vectors' orientation but not the
 * angle between them.
 */
function jointAngleDeg(landmarks: NormalizedLandmark[], mcp: number, joint: number, tip: number): number {
  const a = landmarks[mcp]
  const b = landmarks[joint]
  const c = landmarks[tip]
  const v1 = { x: a.x - b.x, y: a.y - b.y, z: (a.z ?? 0) - (b.z ?? 0) }
  const v2 = { x: c.x - b.x, y: c.y - b.y, z: (c.z ?? 0) - (b.z ?? 0) }
  const mag1 = Math.hypot(v1.x, v1.y, v1.z)
  const mag2 = Math.hypot(v2.x, v2.y, v2.z)
  if (mag1 < 1e-6 || mag2 < 1e-6) return 180
  const cos = (v1.x * v2.x + v1.y * v2.y + v1.z * v2.z) / (mag1 * mag2)
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI
}

/** Every finger's curl state, thumb included — the full-hand reading every
 *  shape below is built from. */
function fingerCurl(landmarks: NormalizedLandmark[]): FingerCurl {
  return {
    thumb: jointAngleDeg(landmarks, THUMB_MCP, THUMB_IP, THUMB_TIP) < THUMB_CURL_ANGLE,
    index: jointAngleDeg(landmarks, INDEX_MCP, INDEX_PIP, INDEX_TIP) < FINGER_CURL_ANGLE,
    middle: jointAngleDeg(landmarks, MIDDLE_MCP, MIDDLE_PIP, MIDDLE_TIP) < FINGER_CURL_ANGLE,
    ring: jointAngleDeg(landmarks, RING_MCP, RING_PIP, RING_TIP) < FINGER_CURL_ANGLE,
    pinky: jointAngleDeg(landmarks, PINKY_MCP, PINKY_PIP, PINKY_TIP) < FINGER_CURL_ANGLE,
  }
}

/** thumb+index tip distance, normalized by palm size so it reads the same
 *  whether the hand is close to the lens or halfway out of frame. The
 *  continuous value one-hand pinch-zoom drives off of — see {@link ZoomController}. */
export function pinchRatio(landmarks: NormalizedLandmark[]): number {
  return distance(landmarks[THUMB_TIP], landmarks[INDEX_TIP]) / palmSize(landmarks)
}

/** All five fingers extended, thumb included — the "stop/navigate" hand.
 *  One-shot, no hysteresis. */
export function detectOpenPalm(landmarks: NormalizedLandmark[]): boolean {
  const c = fingerCurl(landmarks)
  return !c.thumb && !c.index && !c.middle && !c.ring && !c.pinky
}

/** All five fingers curled in, thumb included — the "emergency stop"/rotate
 *  hand. Requiring the thumb is what keeps a pinch (thumb tucked against a
 *  curled index, the other three fingers loose) from reading as a fist: a
 *  real fist tucks every finger in, a pinch only tucks two. One-shot, no
 *  hysteresis. */
export function detectFist(landmarks: NormalizedLandmark[]): boolean {
  const c = fingerCurl(landmarks)
  return c.thumb && [c.index, c.middle, c.ring, c.pinky].filter(Boolean).length >= 3
}

/** Index extended, the other three fingers all curled — the "pinch-zoom"
 *  hand (thumb tip moves freely; it's how far it is from the index tip that
 *  drives zoom, not its curl). All three of middle/ring/pinky have to be
 *  curled — a deliberate, unambiguous shape, unlike a relaxed half-open
 *  hand. One-shot, no hysteresis. */
export function detectPointing(landmarks: NormalizedLandmark[]): boolean {
  const c = fingerCurl(landmarks)
  return !c.index && c.middle && c.ring && c.pinky
}

/** Index and middle extended together, ring and pinky curled — the
 *  "two-finger drag" hand, like scrolling/panning with two fingers on a
 *  touchpad or phone screen. One-shot, no hysteresis. */
export function detectTwoFinger(landmarks: NormalizedLandmark[]): boolean {
  const c = fingerCurl(landmarks)
  return !c.index && !c.middle && c.ring && c.pinky
}

/** How far a hand moved between two frames, in the same normalized space both points are given in. */
export function calculateHandMovement(
  prev: { x: number; y: number },
  curr: { x: number; y: number },
): { dx: number; dy: number } {
  return { dx: curr.x - prev.x, dy: curr.y - prev.y }
}

/** Tracks one hand-shape's on/off state across frames with its own hysteresis. */
class ThresholdTracker {
  private on = false
  constructor(
    private readonly engage: (v: number) => boolean,
    private readonly release: (v: number) => boolean,
  ) {}

  update(value: number): boolean {
    if (this.on) {
      if (this.release(value)) this.on = false
    } else if (this.engage(value)) {
      this.on = true
    }
    return this.on
  }

  reset(): void {
    this.on = false
  }
}

/**
 * Stateful per-hand-slot classifier: smoothed landmarks in, one confident
 * {@link HandShape} out, with hysteresis on every shape so a hand caught
 * exactly at a threshold doesn't flicker between two readings frame to frame.
 *
 * Checked in a fixed priority — fist, then point, then twoFinger, then open —
 * because a closing fist passes through hand-shapes that can momentarily
 * satisfy more than one detector at once, and fist (the emergency stop) must
 * always win that ambiguity, never something less safety-critical. `point`
 * and `twoFinger` never actually compete (one requires the middle finger
 * curled, the other requires it extended), so their relative order doesn't
 * matter beyond that.
 */
export class HandShapeTracker {
  // Full fist, thumb included — gating on the thumb is what stops a
  // thumb-index pinch (which curls at most the index/middle) from reading as
  // "grab to rotate."
  private fist = new ThresholdTracker(
    (v) => v >= 3,
    (v) => v <= 1,
  )
  // Index extended, the rest curled — the one-hand pinch-zoom shape. Thumb
  // position is deliberately not part of this gate: it stays this shape
  // across the whole thumb-index spread range so zoom has a stable trigger
  // to sit inside from fully pinched to fully spread.
  private point = new ThresholdTracker(
    (v) => v >= 3,
    (v) => v <= 1,
  )
  // Index and middle extended together, ring and pinky curled — the
  // two-finger pan/drag shape.
  private twoFinger = new ThresholdTracker(
    (v) => v >= 3,
    (v) => v <= 1,
  )
  // Engages on at most one borderline finger (a pinky or thumb that doesn't
  // fully straighten is common) — strict zero-tolerance made the "open palm"
  // gesture fail for real hands more often than it should.
  private open = new ThresholdTracker(
    (v) => v <= 1,
    (v) => v >= 3,
  )

  classify(landmarks: NormalizedLandmark[]): HandShape {
    const c = fingerCurl(landmarks)
    const curledCount4 = [c.index, c.middle, c.ring, c.pinky].filter(Boolean).length

    // Fist: thumb curled is a hard gate, then tolerate one borderline finger
    // among the other four (full fist = 4, still engages at 3).
    const fistScore = c.thumb ? curledCount4 : 0

    // Point: index extended, middle/ring/pinky all strictly curled.
    const pointScore = !c.index && c.middle && c.ring && c.pinky ? 4 : 0
    // TwoFinger: index and middle strictly extended, ring/pinky strictly curled.
    const twoFingerScore = !c.index && !c.middle && c.ring && c.pinky ? 4 : 0
    // Open: every finger relaxed open, thumb included.
    const curledCount5 = curledCount4 + (c.thumb ? 1 : 0)

    const isFist = this.fist.update(fistScore)
    const isPoint = this.point.update(pointScore)
    const isTwoFinger = this.twoFinger.update(twoFingerScore)
    const isOpen = this.open.update(curledCount5)

    if (isFist) return 'fist'
    if (isPoint) return 'point'
    if (isTwoFinger) return 'twoFinger'
    if (isOpen) return 'open'
    return 'other'
  }

  reset(): void {
    this.fist.reset()
    this.point.reset()
    this.twoFinger.reset()
    this.open.reset()
  }
}
