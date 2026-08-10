import { clamp } from './types'

/**
 * Both-hands-pinched zoom: the change in inter-hand distance since both hands
 * clutched together drives a dolly rate — spread apart to zoom in, pinch back
 * together to zoom out, exactly like a two-finger pinch-zoom on a touchscreen.
 *
 * No activation delay, unlike the navigation/rotate gestures needing none
 * either: pinching with *both* hands at once is already a deliberate, unusual
 * hand shape (unlike two open palms, which is just how hands often rest), so
 * it can arm the instant it happens without a hold-still window.
 */

/** Reads the *relative* change in distance, so it works the same whether the
 *  hands start close together or already apart. */
const ZOOM_DEAD_ZONE = 0.06
const ZOOM_MAX_REACH = 0.6

function zoomAxisFrom(raw: number): number {
  const magnitude = Math.abs(raw)
  if (magnitude < ZOOM_DEAD_ZONE) return 0
  const eased = (magnitude - ZOOM_DEAD_ZONE) / (ZOOM_MAX_REACH - ZOOM_DEAD_ZONE)
  return Math.sign(raw) * clamp(eased, 0, 1)
}

export class ZoomController {
  /** Inter-hand distance captured the instant both hands became pinched together. */
  private reference: number | null = null

  /** Call every frame both hands read as pinched, with the raw (unmirrored)
   *  distance between them — `WarehouseScene.applyHandOrbitZoom` already
   *  clamps the resulting orbit radius to `OrbitControls.minDistance/maxDistance`,
   *  the same limits a mouse wheel is held to, so this can never zoom through
   *  the building or dolly out past where the mouse could take it either. */
  drive(distance: number): number {
    if (this.reference === null) this.reference = distance
    const relativeChange = (distance - this.reference) / Math.max(this.reference, 0.05)
    return zoomAxisFrom(relativeChange)
  }

  /** Call the instant both hands stop being pinched together — the next time
   *  zoom arms, it starts from a fresh reference instead of the stale one. */
  reset(): void {
    this.reference = null
  }
}
