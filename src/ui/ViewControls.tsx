import { CAMERA_PRESETS } from '../scene/cameraPresets'
import { useAppStore } from '../store/useAppStore'
import { cx } from './components/primitives'

/** Camera preset buttons + scene legend, floating over the bottom-left of the canvas. */
export function ViewControls() {
  const cameraPreset = useAppStore((s) => s.cameraPreset)
  const setCameraPreset = useAppStore((s) => s.setCameraPreset)
  const model = useAppStore((s) => s.model)

  return (
    <div className="flex flex-col items-start gap-2">
      <div className="panel-float flex items-center gap-1 p-1">
        {CAMERA_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            title={preset.hint}
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
      </div>

      {model && (
        <div className="panel-float px-2.5 py-1.5">
          <p className="text-[9.5px] leading-relaxed text-ink-400">
            Drag to orbit · scroll to zoom · right-drag to pan
            <br />
            Click a bin, picker or parcel to inspect it
          </p>
        </div>
      )}
    </div>
  )
}
