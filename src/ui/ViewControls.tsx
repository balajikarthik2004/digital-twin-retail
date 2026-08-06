import { useState, type ReactNode } from 'react'
import { CAMERA_PRESETS } from '../scene/cameraPresets'
import { useAppStore } from '../store/useAppStore'
import { cx } from './components/primitives'
import { InfoIcon } from './components/icons'

/**
 * Camera presets and the control legend, floating over the bottom-left of the canvas.
 *
 * The legend is collapsed by default. It is reference material — needed once, on
 * the first visit — and a permanent three-line block of 9px text sitting on the
 * warehouse is the kind of thing that makes a tool look like a prototype. The
 * keys are set as real key caps so they can be found at a glance rather than read.
 */
export function ViewControls() {
  const cameraPreset = useAppStore((s) => s.cameraPreset)
  const setCameraPreset = useAppStore((s) => s.setCameraPreset)
  const model = useAppStore((s) => s.model)
  const [helpOpen, setHelpOpen] = useState(false)

  return (
    <div className="flex flex-col items-start gap-2">
      {model && helpOpen && (
        <div className="panel-float w-[268px] animate-fade-in p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="panel-title">Navigating the floor</span>
            <span className="font-mono text-[9px] text-ink-500">1–5 for views</span>
          </div>
          <dl className="space-y-1.5">
            <LegendRow
              term={
                <>
                  <kbd className="kbd">W</kbd>
                  <kbd className="kbd">A</kbd>
                  <kbd className="kbd">S</kbd>
                  <kbd className="kbd">D</kbd>
                </>
              }
            >
              Walk, or use the arrow keys
            </LegendRow>
            <LegendRow
              term={
                <>
                  <kbd className="kbd">Q</kbd>
                  <kbd className="kbd">E</kbd>
                </>
              }
            >
              Drop and rise
            </LegendRow>
            <LegendRow term={<kbd className="kbd px-1.5">Shift</kbd>}>Hold to run</LegendRow>
            <LegendRow term={<kbd className="kbd px-1.5">Space</kbd>}>Run / pause the shift</LegendRow>
            <LegendRow
              term={
                <>
                  <kbd className="kbd">[</kbd>
                  <kbd className="kbd">]</kbd>
                </>
              }
            >
              Show or hide the side panels
            </LegendRow>
            <LegendRow term={<kbd className="kbd">T</kbd>}>Switch theme</LegendRow>
          </dl>
          <div className="divider !my-2.5" />
          <p className="text-[10px] leading-relaxed text-ink-400">
            Drag to orbit · scroll to zoom · right-drag to pan.
            <br />
            Click any bin, picker or parcel to inspect it.
          </p>
        </div>
      )}

      <div className="panel-float flex items-center gap-1 p-1">
        {CAMERA_PRESETS.map((preset, i) => (
          <button
            key={preset.id}
            type="button"
            title={`${preset.hint} (${i + 1})`}
            onClick={() => setCameraPreset(preset.id)}
            className={cx(
              'rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-all duration-150',
              cameraPreset === preset.id
                ? 'option-active text-accent-soft'
                : 'text-ink-400 hover:bg-ink-750 hover:text-ink-100',
            )}
          >
            {preset.label}
          </button>
        ))}

        {model && (
          <>
            <span className="mx-0.5 h-5 w-px bg-ink-700" />
            <button
              type="button"
              onClick={() => setHelpOpen((open) => !open)}
              title="Keyboard and mouse controls"
              aria-label="Keyboard and mouse controls"
              aria-expanded={helpOpen}
              className={cx(
                'grid h-7 w-7 place-items-center rounded-md transition-all duration-150',
                helpOpen
                  ? 'option-active text-accent-soft'
                  : 'text-ink-400 hover:bg-ink-750 hover:text-ink-100',
              )}
            >
              <InfoIcon size={13} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function LegendRow({ term, children }: { term: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <dt className="flex shrink-0 items-center gap-0.5">{term}</dt>
      <dd className="min-w-0 flex-1 truncate text-[10px] text-ink-300">{children}</dd>
    </div>
  )
}
