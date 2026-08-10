import type { NormalizedLandmark } from '@mediapipe/tasks-vision'
import type { MoveAxes } from '../WarehouseScene'

/** The shapes gestures are built from. One shape per hand per frame. */
export type HandShape = 'fist' | 'pinch' | 'point' | 'open' | 'other'

/** Which control channel is currently live. Only ever one at a time — see
 *  {@link ../HandControlManager.ts} for the priority order that guarantees it. */
export type HandControlMode = 'idle' | 'pan' | 'rotate' | 'zoom'

export type HandControlStatus =
  | 'idle'
  | 'starting'
  | 'tracking'
  | 'no-hand'
  | 'denied'
  | 'unsupported'
  | 'error'

/** One tracked hand's centroid, in the *mirrored* preview's normalized [0,1] space. */
export interface HandPoint {
  x: number
  y: number
  shape: HandShape
  /** This hand is the one currently driving `mode`. */
  active: boolean
}

export interface HandControlSnapshot {
  status: HandControlStatus
  /** Short operator-facing copy, already worded for the state it describes. */
  message: string
  mode: HandControlMode
  /** Every hand currently in frame, 0-2 of them — order is not left/right. */
  hands: HandPoint[]
}

export const HAND_CONTROL_IDLE: HandControlSnapshot = {
  status: 'idle',
  message: 'Off',
  mode: 'idle',
  hands: [],
}

/** Per-frame drive intent: pan feeds `WarehouseScene.setPadAxes`, the rest feeds `setHandRotateZoom`. */
export interface HandDriveIntent {
  pan: MoveAxes
  /** -1..1 — sustained rotate is a fixed magnitude, not proportional to anything. */
  orbitYaw: number
  /** Unused today (no gesture drives pitch) — kept so the channel can grow. */
  orbitPitch: number
  /** -1..1, consumed by `WarehouseScene.applyHandOrbitZoom` as a dolly rate:
   *  positive shrinks the orbit radius (zoom in/closer), negative grows it
   *  (zoom out/further) — spreading hands apart is positive, matching the
   *  pinch-to-zoom gesture on a touchscreen. */
  zoom: number
}

export const ZERO_AXES: MoveAxes = { forward: 0, right: 0, up: 0, sprint: false }
export const ZERO_INTENT: HandDriveIntent = { pan: ZERO_AXES, orbitYaw: 0, orbitPitch: 0, zoom: 0 }

/** A single tracked hand's landmarks reduced to what the gestures need. */
export interface HandReading {
  /** Centroid in the *mirrored* preview's normalized [0,1] space — what the
   *  user sees themselves doing, and what on-screen dots are drawn at. */
  point: { x: number; y: number }
  /** Centroid in raw (unmirrored) model space — needed so distances between two
   *  hands agree with each other regardless of mirroring. */
  rawX: number
  rawY: number
  shape: HandShape
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

export function distance(a: NormalizedLandmark, b: NormalizedLandmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}
