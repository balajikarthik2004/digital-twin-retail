import { useAppStore, type TimeScale } from '../store/useAppStore'
import { Segmented, cx } from './components/primitives'
import { PauseIcon, PlayIcon, ResetIcon } from './components/icons'
import { clock } from './format'

const TIME_SCALES: { value: TimeScale; label: string }[] = [
  { value: 1, label: '1×' },
  { value: 5, label: '5×' },
  { value: 20, label: '20×' },
]

/**
 * Shift transport. Pinned above the section switcher rather than living inside
 * one section, because the clock and the run button are context for all four.
 */
export function SimulationControls() {
  const metrics = useAppStore((s) => s.metrics)
  const orders = useAppStore((s) => s.orders)
  const timeScale = useAppStore((s) => s.timeScale)
  const setTimeScale = useAppStore((s) => s.setTimeScale)
  const start = useAppStore((s) => s.start)
  const pause = useAppStore((s) => s.pause)
  const reset = useAppStore((s) => s.reset)

  const running = metrics?.running ?? false

  return (
    <div className="shrink-0 border-b border-ink-700 bg-ink-900 px-3 py-2.5">
      <div className="flex items-end justify-between gap-2">
        <div className="leading-tight">
          <div className="mini-label">Shift clock</div>
          <div className="font-mono text-[16px] font-semibold tabular-nums text-ink-100">
            {clock(metrics?.time ?? 0)}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span
            className={cx(
              'inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[10px] font-medium',
              running ? 'pill-good' : 'border-ink-600 bg-ink-800 text-ink-400',
            )}
          >
            <span
              className={cx(
                'h-1.5 w-1.5 rounded-full',
                running ? 'animate-pulse bg-good' : 'bg-ink-500',
              )}
            />
            {running ? 'Running' : orders.length === 0 ? 'No orders' : 'Paused'}
          </span>
          <Segmented value={timeScale} options={TIME_SCALES} onChange={setTimeScale} size="sm" />
        </div>
      </div>

      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={() => (running ? pause() : start())}
          className={cx('btn flex-1', running ? '' : 'btn-primary')}
          disabled={orders.length === 0}
          title={orders.length === 0 ? 'Queue some orders first' : 'Space'}
        >
          {running ? <PauseIcon size={11} /> : <PlayIcon size={11} />}
          {running ? 'Pause' : 'Run simulation'}
        </button>
        <button
          type="button"
          onClick={reset}
          className="btn"
          title="Reset clock, agents and metrics"
        >
          <ResetIcon size={11} />
          Reset
        </button>
      </div>
    </div>
  )
}
