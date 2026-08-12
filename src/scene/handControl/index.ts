import type { NormalizedLandmark } from '@mediapipe/tasks-vision'
import { HandControlManager } from './HandControlManager'
import { HandTracker } from './HandTracker'
import { HAND_CONTROL_IDLE, ZERO_INTENT, type HandControlSnapshot, type HandDriveIntent } from './types'

export {
  HAND_CONTROL_IDLE,
  type HandControlMode,
  type HandControlSnapshot,
  type HandControlStatus,
  type HandDriveIntent,
  type HandPoint,
  type HandShape,
} from './types'

/** What the host (the panel component) needs to wire hand control into the
 *  rest of the app. */
export interface HandControlDeps {
  onSnapshot: (snapshot: HandControlSnapshot) => void
  onIntent: (intent: HandDriveIntent) => void
}

/**
 * Full hand-control stack: camera + model ({@link HandTracker}) feeding the
 * gesture state machine ({@link HandControlManager}), wired to the rest of the
 * app through {@link HandControlDeps}.
 *
 * The `<video>` element is mounted once and never unmounted (only hidden), so
 * this instance — and the camera stream it owns — survives toggling the
 * feature off and back on without re-requesting permission or re-loading the
 * tracking model.
 */
export class HandCameraControl {
  private readonly tracker: HandTracker
  private readonly manager = new HandControlManager()
  private readonly deps: HandControlDeps
  private disposed = false

  constructor(video: HTMLVideoElement, deps: HandControlDeps) {
    this.deps = deps
    this.tracker = new HandTracker(
      video,
      (status, message) => {
        if (this.disposed) return
        this.deps.onSnapshot({ ...HAND_CONTROL_IDLE, status, message })
      },
      (landmarksList, timestamp) => this.onFrame(landmarksList, timestamp),
    )
  }

  setSensitivity(v: number): void {
    this.manager.setSensitivity(v)
  }

  async start(): Promise<void> {
    await this.tracker.start()
  }

  stop(): void {
    this.tracker.stop()
    this.manager.reset()
    this.deps.onIntent(ZERO_INTENT)
  }

  dispose(): void {
    this.disposed = true
    this.tracker.dispose()
  }

  private onFrame(landmarksList: NormalizedLandmark[][], timestamp: number): void {
    if (this.disposed) return
    const { snapshot, intent } = this.manager.handleGesture(landmarksList, timestamp)
    this.deps.onSnapshot(snapshot)
    this.deps.onIntent(intent)
  }
}
