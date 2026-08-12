import { useEffect, useRef, useState, type RefObject } from 'react'
import {
  HAND_CONTROL_IDLE,
  HandCameraControl,
  type HandControlMode,
  type HandControlSnapshot,
  type HandPoint,
} from '../scene/handControl'
import type { WarehouseScene } from '../scene/WarehouseScene'
import { cx, Slider } from './components/primitives'
import { FistIcon, InfoIcon, PinchIcon, TwoFingerIcon } from './components/icons'

/** Persisted across sessions so a user who tunes it once doesn't have to again. */
const SENSITIVITY_KEY = 'picktwin.hand-sensitivity'
const DEFAULT_SENSITIVITY = 1

/** How long the control guide stays open on its own before tucking away — long
 *  enough to read once, short enough not to sit over the warehouse forever. */
const LEGEND_AUTO_HIDE_MS = 6500

function loadSensitivity(): number {
  try {
    const raw = Number(localStorage.getItem(SENSITIVITY_KEY))
    return raw >= 0.5 && raw <= 2 ? raw : DEFAULT_SENSITIVITY
  } catch {
    return DEFAULT_SENSITIVITY // Private mode / storage disabled.
  }
}

function saveSensitivity(v: number): void {
  try {
    localStorage.setItem(SENSITIVITY_KEY, String(v))
  } catch {
    // Private mode / storage disabled — the slider still works for this session.
  }
}

const LEGEND = [
  {
    Icon: PinchIcon,
    tone: 'text-good',
    label: 'Thumb + index',
    detail: 'Zoom — spread the tips apart to zoom in, bring them together to zoom out',
  },
  {
    Icon: TwoFingerIcon,
    tone: 'text-accent-soft',
    label: 'Index + middle',
    detail: 'Pan — hold together and move your hand, like scrolling with two fingers',
  },
  { Icon: FistIcon, tone: 'text-warn', label: 'Make a fist', detail: 'Rotate — a slow 360° spin; open your hand to stop' },
]

/** Small status dot + label, same convention as the sim's running/paused indicator. */
function statusIndicator(mode: HandControlMode): { dotClass: string; label: string } {
  switch (mode) {
    case 'pan':
      return { dotClass: 'animate-pulse bg-accent', label: 'Panning' }
    case 'rotate':
      return { dotClass: 'animate-pulse bg-warn', label: 'Rotating' }
    case 'zoom':
      return { dotClass: 'animate-pulse bg-good', label: 'Zooming' }
    default:
      return { dotClass: 'bg-ink-500', label: 'Ready' }
  }
}

/**
 * Which colour a tracked hand's dot takes. Driven by `mode` + `active`, not
 * shape alone — a hand that happens to be shaped like a fist while the *other*
 * hand's two-finger drag is the one actually panning must not light up as if
 * it were rotating something; nothing is.
 */
function toneFor(mode: HandControlMode, active: boolean): 'accent' | 'warn' | 'good' | 'neutral' {
  if (!active) return 'neutral'
  if (mode === 'pan') return 'accent'
  if (mode === 'rotate') return 'warn'
  if (mode === 'zoom') return 'good'
  return 'neutral'
}

/**
 * Toggle + live preview for steering the camera by hand instead of the mouse
 * and keyboard.
 *
 * Floats top-right of the viewport, deliberately clear of the camera-preset
 * bar (bottom-left) and the minimap (bottom-right). Mouse drag/scroll/pan and
 * WASD keep working exactly as before whether this is on or off — it only
 * ever adds a third source of input alongside them, via
 * `WarehouseScene.setPadAxes` (pan) and `WarehouseScene.setHandRotateZoom`
 * (rotate/zoom).
 *
 * Three gestures, one hand, one active at a time (see `HandControlManager`
 * for the priority order): thumb + index to zoom, index + middle held
 * together to pan, or a closed fist to rotate — the same finger pairings a
 * phone or touchpad already uses, so there's nothing new to learn.
 *
 * The `<video>` element is mounted once and never unmounted (only hidden), so
 * the underlying `HandCameraControl` — and the camera stream it owns —
 * survives toggling the feature off and back on without re-requesting
 * permission or re-loading the tracking model.
 */
export function HandControlPanel({ sceneRef }: { sceneRef: RefObject<WarehouseScene | null> }) {
  const [enabled, setEnabled] = useState(false)
  const [snapshot, setSnapshot] = useState<HandControlSnapshot>(HAND_CONTROL_IDLE)
  const [showLegend, setShowLegend] = useState(false)
  const [sensitivity, setSensitivity] = useState(loadSensitivity)
  const videoRef = useRef<HTMLVideoElement>(null)
  const controlRef = useRef<HandCameraControl | null>(null)
  const legendTimerRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const control = new HandCameraControl(video, {
      onSnapshot: setSnapshot,
      onIntent: (intent) => {
        sceneRef.current?.setPadAxes(intent.pan)
        sceneRef.current?.setHandRotateZoom({
          yaw: intent.orbitYaw,
          pitch: intent.orbitPitch,
          zoom: intent.zoom,
        })
      },
    })
    control.setSensitivity(sensitivity)
    controlRef.current = control
    return () => control.dispose()
    // sceneRef is a stable ref identity for the lifetime of SceneView; `sensitivity`
    // is applied once here and kept current by the effect below — this runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    controlRef.current?.setSensitivity(sensitivity)
  }, [sensitivity])

  useEffect(() => {
    if (enabled) {
      void controlRef.current?.start()
      setShowLegend(true)
    } else {
      controlRef.current?.stop()
      setSnapshot(HAND_CONTROL_IDLE)
      setShowLegend(false)
    }
  }, [enabled])

  // Auto-minimize the guide a few seconds after it opens — reachable again
  // any time via the info button.
  useEffect(() => {
    window.clearTimeout(legendTimerRef.current)
    if (showLegend) {
      legendTimerRef.current = window.setTimeout(() => setShowLegend(false), LEGEND_AUTO_HIDE_MS)
    }
    return () => window.clearTimeout(legendTimerRef.current)
  }, [showLegend])

  const loading = snapshot.status === 'starting'
  const failed = snapshot.status === 'denied' || snapshot.status === 'unsupported' || snapshot.status === 'error'
  const indicator = statusIndicator(snapshot.mode)

  return (
    <div className="flex flex-col items-end gap-2">
      <div
        className={cx(
          'panel-float w-[228px] origin-top-right overflow-hidden transition-all duration-200 ease-out',
          enabled ? 'max-h-[440px] opacity-100' : 'pointer-events-none max-h-0 opacity-0',
        )}
      >
        <div className="relative aspect-[4/3] w-full overflow-hidden bg-ink-950">
          <video
            ref={videoRef}
            muted
            playsInline
            className="h-full w-full -scale-x-100 object-cover opacity-95"
          />

          {!failed &&
            snapshot.hands.map((hand, i) => (
              <HandDot key={i} point={hand} tone={toneFor(snapshot.mode, hand.active)} />
            ))}

          {(loading || snapshot.status === 'idle') && (
            <div className="absolute inset-0 grid place-items-center bg-ink-950/70">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-ink-700 border-t-accent" />
            </div>
          )}

          {failed && (
            <div className="absolute inset-0 grid place-items-center bg-ink-950/85 px-3 text-center">
              <p className="text-[10px] leading-snug text-ink-300">{snapshot.message}</p>
            </div>
          )}

          <button
            type="button"
            onClick={() => setShowLegend((v) => !v)}
            title="What do the gestures do?"
            aria-pressed={showLegend}
            className={cx(
              'absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full backdrop-blur transition-colors',
              showLegend ? 'bg-accent/80 text-ink-950' : 'bg-ink-950/60 text-ink-200 hover:bg-ink-950/80',
            )}
          >
            <InfoIcon size={12} />
          </button>
        </div>

        {showLegend && (
          <div className="animate-fade-in space-y-1.5 border-t border-ink-700 bg-ink-850/60 px-2.5 py-2">
            {LEGEND.map(({ Icon, tone, label, detail }) => (
              <div key={label} className="flex items-start gap-1.5">
                <Icon size={12} className={cx('mt-0.5 shrink-0', tone)} />
                <p className="text-[10px] leading-snug text-ink-300">
                  <span className="font-medium text-ink-100">{label}</span> — {detail}
                </p>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-1.5 border-t border-ink-700 px-2.5 py-2">
          <span className={cx('h-2 w-2 shrink-0 rounded-full', failed ? 'bg-ink-500' : indicator.dotClass)} />
          <p
            className={cx(
              'text-[10.5px] font-medium leading-snug',
              snapshot.mode !== 'idle' ? 'text-accent-soft' : 'text-ink-300',
            )}
          >
            {failed ? 'Hand control unavailable' : indicator.label}
          </p>
        </div>

        {!failed && (
          <div className="border-t border-ink-700 px-2.5 py-1.5">
            <p className="text-[10px] leading-snug text-ink-400">{snapshot.message}</p>
          </div>
        )}

        <div className="border-t border-ink-700 px-2.5 py-2">
          <Slider
            label="Sensitivity"
            value={sensitivity}
            min={0.5}
            max={2}
            step={0.1}
            suffix="×"
            format={(v) => v.toFixed(1)}
            onChange={(v) => {
              setSensitivity(v)
              saveSensitivity(v)
            }}
          />
        </div>
      </div>

      <button
        type="button"
        onClick={() => setEnabled((v) => !v)}
        title="Steer the camera with your hands via the webcam — pan, rotate and zoom"
        aria-pressed={enabled}
        className={cx(
          'panel-float flex h-8 items-center gap-1.5 rounded-full px-3 text-[11px] font-medium transition-all duration-150',
          enabled ? 'option-active text-accent-soft' : 'text-ink-400 hover:bg-ink-750 hover:text-ink-100',
        )}
      >
        <PinchIcon size={13} />
        Hand control
      </button>
    </div>
  )
}

function HandDot({ point, tone }: { point: HandPoint; tone: 'accent' | 'warn' | 'good' | 'neutral' }) {
  const toneClass =
    tone === 'accent'
      ? 'border-accent bg-accent/40 shadow-glow'
      : tone === 'warn'
        ? 'border-warn bg-warn/40'
        : tone === 'good'
          ? 'border-good bg-good/40'
          : 'border-ink-100/80 bg-ink-950/20'
  return (
    <span
      className={cx(
        'absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 transition-colors duration-100',
        toneClass,
      )}
      style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
    />
  )
}
