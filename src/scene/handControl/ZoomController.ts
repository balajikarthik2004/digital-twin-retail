
/**
 * One-hand pinch-zoom: extend thumb and index (the other three fingers
 * curled — MediaPipe's `point` shape) and the change in tip-to-tip distance
 * since that shape engaged drives a dolly rate — spread thumb and index
 * apart to zoom in, bring them back together to zoom out. Same gesture as a
 * two-finger pinch-zoom on a touchscreen, just performed with one hand's own
 * two fingers instead of two separate touch points.
 *
 * No activation delay, unlike the navigation/rotate gestures needing none
 * either: index-extended-others-curled is already a deliberate, unusual hand
 * shape (unlike an open palm, which is just how a hand often rests), so it
 * can arm the instant it happens without a hold-still window.
 */

/** Frame-to-frame scale change below this is treated as tracking noise. */
const NOISE_FLOOR = 0.005
/** Ceiling on one frame's scale change. A mistracked frame — a hand half out of
 *  view, a finger briefly occluded — can otherwise report an enormous jump in
 *  pinch distance and throw the camera across the building in a single step. */
const MAX_STEP = 0.06

export class ZoomController {
  private lastPinch: number | null = null

  drive(pinchRatio: number): number {
    if (this.lastPinch === null) {
      this.lastPinch = pinchRatio
      return 0
    }

    // Prevent division by zero if fingers touch completely
    const currentPinch = Math.max(pinchRatio, 0.01)
    const prevPinch = Math.max(this.lastPinch, 0.01)

    // Geometric scale: if you spread fingers 2x wider, radius halves (zoom in 2x).
    // If you bring them 2x closer, radius doubles (zoom out 2x).
    // WarehouseScene applies: radius * (1 - zoom)
    // So we need: 1 - zoom = prevPinch / currentPinch
    const scale = prevPinch / currentPinch
    const zoomDelta = 1 - scale

    // Below the noise floor, hold the reference *unmoved* rather than consuming
    // it. Advancing it here would silently eat every sub-threshold frame, so a
    // slow, deliberate spread — the one you make when placing a shot precisely —
    // would never accumulate into any zoom at all. Held, it accumulates until it
    // clears the floor, which is why fine control works and jitter still doesn't.
    if (Math.abs(zoomDelta) < NOISE_FLOOR) return 0

    this.lastPinch = currentPinch

    // Soft knee: subtract the floor instead of passing the full delta the moment
    // it clears. Output is continuous through the threshold, so zoom starts from
    // nothing and builds, rather than snapping to a step as it crosses.
    const eased = Math.sign(zoomDelta) * (Math.abs(zoomDelta) - NOISE_FLOOR)
    return Math.max(-MAX_STEP, Math.min(MAX_STEP, eased))
  }

  reset(): void {
    this.lastPinch = null
  }
}
