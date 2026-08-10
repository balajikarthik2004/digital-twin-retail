import type { HandLandmarker, NormalizedLandmark } from '@mediapipe/tasks-vision'
import type { HandControlStatus } from './types'

/**
 * Owns the webcam stream and the MediaPipe `HandLandmarker` model. Nothing in
 * here knows what a gesture is — it only ever hands back raw per-frame
 * landmark lists (up to two hands) for {@link HandControlManager} to
 * interpret. Keeping the camera/model plumbing separate from gesture logic is
 * what lets the gesture rules be unit-testable without a browser.
 *
 * Model: MediaPipe's `HandLandmarker`, run entirely in-browser (WASM/GPU,
 * `public/vision/`) against a local model file
 * (`public/models/hand_landmarker.task`) — no frames ever leave the machine,
 * and the feature has zero runtime dependency on a CDN once installed.
 */
export class HandTracker {
  private readonly video: HTMLVideoElement
  private readonly onStatus: (status: HandControlStatus, message: string) => void
  private readonly onFrame: (landmarksList: NormalizedLandmark[][]) => void

  private landmarker: HandLandmarker | null = null
  private stream: MediaStream | null = null
  private raf = 0
  private disposed = false
  private running = false

  constructor(
    video: HTMLVideoElement,
    onStatus: (status: HandControlStatus, message: string) => void,
    onFrame: (landmarksList: NormalizedLandmark[][]) => void,
  ) {
    this.video = video
    this.onStatus = onStatus
    this.onFrame = onFrame
  }

  async start(): Promise<void> {
    if (this.running || this.disposed) return
    if (!navigator.mediaDevices?.getUserMedia) {
      this.onStatus('unsupported', 'This browser cannot expose a camera to the page.')
      return
    }

    this.onStatus('starting', 'Asking for the camera…')

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: 'user' },
        audio: false,
      })
    } catch {
      this.onStatus('denied', 'Camera permission was not granted.')
      return
    }
    if (this.disposed) {
      stopTracks(this.stream)
      return
    }

    this.video.srcObject = this.stream
    try {
      await this.video.play()
    } catch {
      // Autoplay can reject if the tab lost focus mid-request; the loop below
      // still starts and will pick up frames once playback actually begins.
    }

    if (!this.landmarker) {
      this.onStatus('starting', 'Loading the hand tracker…')
      try {
        this.landmarker = await this.createLandmarker()
      } catch {
        this.onStatus('error', 'Could not load the hand-tracking model.')
        this.teardownStream()
        return
      }
    }
    if (this.disposed) return

    this.running = true
    this.onStatus('no-hand', 'Show a hand to the camera.')
    this.loop()
  }

  /** Releases the camera and stops detecting; the loaded model stays warm for a fast restart. */
  stop(): void {
    this.running = false
    cancelAnimationFrame(this.raf)
    this.teardownStream()
  }

  dispose(): void {
    this.disposed = true
    this.stop()
    this.landmarker?.close()
    this.landmarker = null
  }

  private async createLandmarker(): Promise<HandLandmarker> {
    const { FilesetResolver, HandLandmarker } = await import('@mediapipe/tasks-vision')
    const fileset = await FilesetResolver.forVisionTasks('/vision')
    const baseOptions = { modelAssetPath: '/models/hand_landmarker.task' }
    const shared = {
      runningMode: 'VIDEO' as const,
      numHands: 2,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.6,
    }
    try {
      return await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { ...baseOptions, delegate: 'GPU' },
        ...shared,
      })
    } catch {
      // Some GPUs/drivers reject the WebGL delegate; CPU is slower but always works.
      return await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { ...baseOptions, delegate: 'CPU' },
        ...shared,
      })
    }
  }

  private loop = () => {
    if (!this.running || this.disposed || !this.landmarker) return
    this.raf = requestAnimationFrame(this.loop)
    if (this.video.readyState < 2) return // HAVE_CURRENT_DATA — nothing decoded yet

    const result = this.landmarker.detectForVideo(this.video, performance.now())
    this.onFrame(result.landmarks ?? [])
  }

  private teardownStream(): void {
    stopTracks(this.stream)
    this.stream = null
    this.video.srcObject = null
  }
}

function stopTracks(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop())
}
