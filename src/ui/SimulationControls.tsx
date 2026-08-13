import { useAppStore, type TimeScale } from '../store/useAppStore'
import { cx } from './components/primitives'
import { ClockIcon, PauseIcon, PlayIcon, ResetIcon } from './components/icons'
import { clock } from './format'

const TIME_SCALES: TimeScale[] = [1, 5, 10, 20]

/**
 * Shift transport. Pinned above the section switcher rather than living inside
 * one section, because the clock and the run button are context for all four.
 *
 * Renders the *contents* of the rail's head card; {@link App} pairs it with
 * {@link SectionNav} inside one `.panel` so the transport and the tab strip it
 * sits above read as a single object, the way they do on the floor — you set
 * the shift running, then choose which part of it to look at.
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
  const status = running ? 'Running' : orders.length === 0 ? 'No orders' : 'Paused'

  return (
    <div className="p-3">
      <div className="panel-title mb-2.5">Simulation control</div>

        {/* Clock and run state side by side: the two facts you check first. */}
        <div className="flex items-start justify-between gap-3">
          <div className="leading-tight">
            <div className="mini-label flex items-center gap-1">
              <ClockIcon size={10} />
              Shift clock
            </div>
            <div className="mt-0.5 font-mono text-[19px] font-semibold tabular-nums leading-none text-ink-100">
              {clock(metrics?.time ?? 0)}
            </div>
          </div>

          <div className="text-right leading-tight">
            <div className="mini-label">Status</div>
            <span
              className={cx(
                'mt-1 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold',
                running ? 'pill-good' : 'border-ink-700 bg-ink-850 text-ink-400',
              )}
            >
              <span
                className={cx(
                  'h-1.5 w-1.5 rounded-full',
                  running ? 'animate-pulse bg-good' : 'bg-ink-500',
                )}
              />
              {status}
            </span>
          </div>
        </div>

        {/* Speed. Four equal buttons rather than a compact segmented control —
            this is the one setting a demo operator changes mid-sentence. */}
        <div className="mt-3 flex gap-1.5">
          {TIME_SCALES.map((scale) => (
            <button
              key={scale}
              type="button"
              onClick={() => setTimeScale(scale)}
              aria-pressed={timeScale === scale}
              className={cx('seg-option', timeScale === scale && 'seg-option-active')}
              title={`Run the clock at ${scale}× real time`}
            >
              {scale}×
            </button>
          ))}
        </div>

        {/* Run takes the remaining width and Reset only what it needs: they are
            one row, but not one choice — the destructive one should not present
            itself as an equal half of the pair. */}
        <div className="mt-2.5 flex gap-2">
          <button
            type="button"
            onClick={() => (running ? pause() : start())}
            className={cx('btn btn-lg flex-1', running ? '' : 'btn-primary')}
            disabled={orders.length === 0}
            title={orders.length === 0 ? 'Queue some orders first' : 'Space'}
          >
            {running ? <PauseIcon size={12} /> : <PlayIcon size={12} />}
            {running ? 'Pause' : 'Run simulation'}
          </button>

          <button
            type="button"
            onClick={reset}
            className="btn btn-lg shrink-0"
            title="Reset clock, agents and metrics"
          >
            <ResetIcon size={12} />
            Reset
          </button>
        </div>
    </div>
  )
}
