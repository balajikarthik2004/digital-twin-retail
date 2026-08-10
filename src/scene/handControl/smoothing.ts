import type { NormalizedLandmark } from '@mediapipe/tasks-vision'

/** Exponential-smoothing weight for landmark positions — higher tracks the raw
 *  signal more closely (more responsive, more jitter), lower lags more but is
 *  steadier. 0.35 is a middle ground: perceptibly smoother than raw MediaPipe
 *  output without feeling laggy at normal hand speed. */
export const SMOOTHING_FACTOR = 0.35

/**
 * Per-hand exponential-moving-average filter over all 21 landmarks.
 *
 * A webcam's per-landmark noise is what makes raw hand tracking look shaky —
 * fine for a debug overlay, unusable for a camera you are trying to hold
 * steady. One instance per tracked hand *slot* (see {@link GestureDetector}
 * for how slots are assigned); call {@link reset} when a slot's hand changes
 * identity (disappears and a different hand takes the slot) so the filter
 * doesn't ease toward a stale position.
 */
export class LandmarkSmoother {
  private prev: NormalizedLandmark[] | null = null

  smooth(landmarks: NormalizedLandmark[]): NormalizedLandmark[] {
    this.prev = smoothLandmarks(this.prev, landmarks)
    return this.prev
  }

  reset(): void {
    this.prev = null
  }
}

/** Pure one-step exponential-smoothing pass: eases `curr` toward `prev` by
 *  {@link SMOOTHING_FACTOR}, or returns `curr` unchanged if there is no prior
 *  frame (or the hand count changed, which invalidates any prior lerp). */
export function smoothLandmarks(
  prev: NormalizedLandmark[] | null,
  curr: NormalizedLandmark[],
  factor = SMOOTHING_FACTOR,
): NormalizedLandmark[] {
  if (!prev || prev.length !== curr.length) return curr.map((p) => ({ ...p }))
  return curr.map((p, i) => ({
    x: lerp(prev[i].x, p.x, factor),
    y: lerp(prev[i].y, p.y, factor),
    z: lerp(prev[i].z ?? 0, p.z ?? 0, factor),
    visibility: p.visibility,
  }))
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}
