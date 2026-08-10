import type { NormalizedLandmark } from '@mediapipe/tasks-vision'
import { distance, type HandShape } from './types'

/**
 * Turns one hand's 21 smoothed landmarks into a shape: `fist`, `pinch`,
 * `point`, `open`, or `other`. Stateless one-shot detector functions are
 * exported for reuse/testing; the pipeline itself goes through
 * {@link HandShapeTracker}, which adds hysteresis so a shape doesn't flicker
 * right at its threshold — the single biggest source of "the camera twitched
 * for no reason" bug reports in gesture UIs.
 */

/** A finger counts as curled when its tip sits closer to the wrist than its
 *  own knuckle does — rotation-invariant (works with the hand held sideways
 *  or upside down), unlike comparing on-screen y-coordinates. */
const FIST_CURL_RATIO = 0.85

/** Pinch distance / palm size. Two thresholds (engage lower than release) so
 *  the clutch doesn't chatter right at the edge — see {@link ThresholdTracker}. */
const PINCH_ENGAGE = 0.55
const PINCH_RELEASE = 0.72

/** Landmark indices, MediaPipe's Hand model. */
const WRIST = 0
const THUMB_TIP = 4
const INDEX_MCP = 5
const INDEX_TIP = 8
const MIDDLE_MCP = 9
const MIDDLE_TIP = 12
const RING_MCP = 13
const RING_TIP = 16
const PINKY_MCP = 17
const PINKY_TIP = 20

interface FingerCurl {
  index: boolean
  middle: boolean
  ring: boolean
  pinky: boolean
}

function palmSize(landmarks: NormalizedLandmark[]): number {
  return Math.max(distance(landmarks[WRIST], landmarks[MIDDLE_MCP]), 0.02)
}

function fingerCurl(landmarks: NormalizedLandmark[]): FingerCurl {
  const wrist = landmarks[WRIST]
  const curled = (tip: number, mcp: number) =>
    distance(landmarks[tip], wrist) < distance(landmarks[mcp], wrist) * FIST_CURL_RATIO
  return {
    index: curled(INDEX_TIP, INDEX_MCP),
    middle: curled(MIDDLE_TIP, MIDDLE_MCP),
    ring: curled(RING_TIP, RING_MCP),
    pinky: curled(PINKY_TIP, PINKY_MCP),
  }
}

/** thumb+index tip distance, normalized by palm size so it reads the same
 *  whether the hand is close to the lens or halfway out of frame. */
export function pinchRatio(landmarks: NormalizedLandmark[]): number {
  return distance(landmarks[THUMB_TIP], landmarks[INDEX_TIP]) / palmSize(landmarks)
}

/** All four fingers extended — the "stop/navigate" hand. One-shot, no hysteresis. */
export function detectOpenPalm(landmarks: NormalizedLandmark[]): boolean {
  const c = fingerCurl(landmarks)
  return !c.index && !c.middle && !c.ring && !c.pinky
}

/** All four fingers curled in — the "emergency stop" hand. One-shot, no hysteresis. */
export function detectFist(landmarks: NormalizedLandmark[]): boolean {
  const c = fingerCurl(landmarks)
  return [c.index, c.middle, c.ring, c.pinky].filter(Boolean).length >= 3
}

/** Index extended, the other three curled — the "select" hand. One-shot, no hysteresis. */
export function detectPointing(landmarks: NormalizedLandmark[]): boolean {
  const c = fingerCurl(landmarks)
  return !c.index && [c.middle, c.ring, c.pinky].filter(Boolean).length >= 2
}

/** Thumb and index tip close together — the "interact" hand. */
export function detectPinch(landmarks: NormalizedLandmark[], threshold = PINCH_ENGAGE): boolean {
  return pinchRatio(landmarks) < threshold
}

/** Both hands confidently tracked — the gate for two-hand mode even starting
 *  to consider itself, before either hand's shape is looked at. */
export function detectTwoHands(handCount: number): boolean {
  return handCount === 2
}

/** Straight-line distance between two hands' raw centroids. */
export function calculateHandDistance(a: { rawX: number; rawY: number }, b: { rawX: number; rawY: number }): number {
  return Math.hypot(a.rawX - b.rawX, a.rawY - b.rawY)
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
 * Checked in a fixed priority — fist, then pinch, then point, then open —
 * because a closing fist passes through hand-shapes that can momentarily
 * satisfy more than one detector at once, and fist (the emergency stop) must
 * always win that ambiguity, never something less safety-critical.
 */
export class HandShapeTracker {
  private fist = new ThresholdTracker(
    (v) => v >= 3,
    (v) => v <= 1,
  )
  private pinch = new ThresholdTracker(
    (v) => v < PINCH_ENGAGE,
    (v) => v > PINCH_RELEASE,
  )
  private point = new ThresholdTracker(
    (v) => v >= 3,
    (v) => v <= 1,
  )
  // Engages on at most one borderline finger (a pinky or ring finger that
  // doesn't fully straighten is common) — strict zero-tolerance made the
  // "open palm" gesture fail for real hands more often than it should.
  private open = new ThresholdTracker(
    (v) => v <= 1,
    (v) => v >= 3,
  )

  classify(landmarks: NormalizedLandmark[]): HandShape {
    const c = fingerCurl(landmarks)
    const curledCount = [c.index, c.middle, c.ring, c.pinky].filter(Boolean).length
    const pointScore = (c.index ? 0 : 1) + [c.middle, c.ring, c.pinky].filter(Boolean).length

    const isFist = this.fist.update(curledCount)
    const isPinch = this.pinch.update(pinchRatio(landmarks))
    const isPoint = this.point.update(pointScore)
    const isOpen = this.open.update(curledCount)

    if (isFist) return 'fist'
    if (isPinch) return 'pinch'
    if (isPoint) return 'point'
    if (isOpen) return 'open'
    return 'other'
  }

  reset(): void {
    this.fist.reset()
    this.pinch.reset()
    this.point.reset()
    this.open.reset()
  }
}
