import type { Route, Vec2 } from '../pathfinding/types'
import { sampleRoute } from '../simulation/engine'

/**
 * The operator who actually walks the putaway.
 *
 * Deliberately outside `SimulationEngine`: a putaway is something the user
 * commissions by hand, and it has to run whether the shift clock is going or
 * not — you can plan and place stock on a paused twin. The state machine is
 * pure (no Three.js, no React), so the scene reads a pose and React reads a
 * throttled progress snapshot, exactly like the picking fleet.
 */

export type WalkerPhase =
  /** Carrying the pallet from goods-in to the location. */
  | 'walking'
  /** Standing at the shelf, putting the stock away. */
  | 'placing'
  /** Empty-handed, heading back to goods-in. */
  | 'returning'
  | 'done'

export interface WalkerState {
  phase: WalkerPhase
  pos: Vec2
  heading: number
  /** 0..1 along the leg currently being walked. */
  progress: number
  dwellRemaining: number
  /** Metres covered across both legs. */
  distance: number
}

export interface WalkerOptions {
  /** Walking pace, m/s. Slower than a picker — they are pushing a loaded pallet. */
  speed: number
  /** Seconds spent at the shelf lifting the stock into the location. */
  handleSec: number
  /** Fired once, the moment the stock lands on the shelf. */
  onArrive(): void
  /** Fired once the operator is back at goods-in and out of the way. */
  onFinish(): void
}

export class PutawayWalker {
  private arc = 0
  private phase: WalkerPhase = 'walking'
  private dwell: number
  private travelled = 0
  private arrived = false
  private finished = false

  constructor(
    readonly route: Route,
    private readonly opts: WalkerOptions,
  ) {
    this.dwell = Math.max(0.1, opts.handleSec)
  }

  /** @param dt Seconds of simulated time — the caller applies the time scale. */
  advance(dt: number): void {
    if (this.phase === 'done' || dt <= 0) return
    const speed = Math.max(0.2, this.opts.speed)
    const total = this.route.distance

    if (this.phase === 'walking') {
      const step = Math.min(speed * dt, total - this.arc)
      this.arc += step
      this.travelled += step
      if (this.arc >= total - 1e-6) {
        this.arc = total
        this.phase = 'placing'
      }
      return
    }

    if (this.phase === 'placing') {
      this.dwell -= dt
      if (this.dwell > 0) return
      // The stock lands exactly here — not when the button was pressed.
      if (!this.arrived) {
        this.arrived = true
        this.opts.onArrive()
      }
      this.phase = 'returning'
      return
    }

    if (this.phase === 'returning') {
      // Empty-handed, so the walk back is quicker than the walk out.
      const step = Math.min(speed * 1.25 * dt, this.arc)
      this.arc -= step
      this.travelled += step
      if (this.arc <= 1e-6) {
        this.arc = 0
        this.phase = 'done'
        if (!this.finished) {
          this.finished = true
          this.opts.onFinish()
        }
      }
    }
  }

  /**
   * Collapse the whole trip immediately — used when the user navigates away
   * mid-walk. The stock still lands; only the animation is skipped.
   */
  finishNow(): void {
    if (!this.arrived) {
      this.arrived = true
      this.opts.onArrive()
    }
    this.phase = 'done'
    this.arc = 0
    if (!this.finished) {
      this.finished = true
      this.opts.onFinish()
    }
  }

  get state(): WalkerState {
    const pose = sampleRoute(this.route, this.arc)
    const total = this.route.distance || 1
    return {
      phase: this.phase,
      pos: pose.pos,
      // Facing back the way it came on the return leg.
      heading: this.phase === 'returning' ? pose.heading + Math.PI : pose.heading,
      progress:
        this.phase === 'walking'
          ? this.arc / total
          : this.phase === 'placing'
            ? 1
            : 1 - this.arc / total,
      dwellRemaining: Math.max(0, this.dwell),
      distance: this.travelled,
    }
  }
}
