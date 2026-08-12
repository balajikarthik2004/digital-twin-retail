
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

    this.lastPinch = currentPinch
    
    // Ignore microscopic tracking noise to make it feel completely rock-solid
    if (Math.abs(zoomDelta) < 0.005) {
      return 0
    }

    return zoomDelta
  }

  reset(): void {
    this.lastPinch = null
  }
}
