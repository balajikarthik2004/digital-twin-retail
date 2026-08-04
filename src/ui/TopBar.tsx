import { getStrategy } from '../pathfinding/strategies'
import { useAppStore, type TimeScale } from '../store/useAppStore'
import { Segmented, cx } from './components/primitives'
import { clock } from './format'

const TIME_SCALES: { value: TimeScale; label: string }[] = [
  { value: 1, label: '1×' },
  { value: 5, label: '5×' },
  { value: 20, label: '20×' },
]

export function TopBar() {
  const layouts = useAppStore((s) => s.layouts)
  const layoutId = useAppStore((s) => s.layoutId)
  const model = useAppStore((s) => s.model)
  const metrics = useAppStore((s) => s.metrics)
  const settings = useAppStore((s) => s.settings)
  const timeScale = useAppStore((s) => s.timeScale)
  const orders = useAppStore((s) => s.orders)
  const leftOpen = useAppStore((s) => s.leftOpen)
  const rightOpen = useAppStore((s) => s.rightOpen)
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)

  const start = useAppStore((s) => s.start)
  const pause = useAppStore((s) => s.pause)
  const reset = useAppStore((s) => s.reset)
  const setTimeScale = useAppStore((s) => s.setTimeScale)
  const selectLayout = useAppStore((s) => s.selectLayout)
  const toggle = useAppStore((s) => s.toggle)

  const running = metrics?.running ?? false
  const strategy = getStrategy(settings.strategyId)

  return (
    <header className="z-30 flex h-14 shrink-0 items-center gap-3 border-b border-ink-700 bg-ink-900 px-3 shadow-panel">
      <button
        type="button"
        onClick={() => toggle('leftOpen')}
        className={cx('btn btn-icon', leftOpen && 'text-accent-soft')}
        title="Toggle controls panel"
      >
        ☰
      </button>

      <div className="flex items-center gap-2.5">
        <div
          className="grid h-8 w-8 place-items-center rounded-lg text-white shadow-sm"
          style={{ background: 'rgb(var(--accent))' }}
        >
          {/* Racking mark — two shelf bays, the product's logo. */}
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
            <path
              d="M2.5 14.5V6l3.2-2 3.2 2v8.5M9 14.5V8.4l3.2-2 3.2 2v6.1M2.5 10.2h6.4M9 11.6h6.4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <div className="leading-tight">
          <div className="text-[13px] font-semibold tracking-tight text-ink-100">PickTwin</div>
          <div className="text-[10px] text-ink-400">Warehouse Execution Twin</div>
        </div>
      </div>

      <div className="mx-1 h-7 w-px bg-ink-700" />

      <label className="flex items-center gap-2">
        <span className="sr-only">Warehouse layout</span>
        <select
          value={layoutId}
          onChange={(e) => selectLayout(e.target.value)}
          className="rounded-lg border border-ink-600 bg-ink-800 px-2.5 py-1.5 text-xs text-ink-100 outline-none transition-colors hover:border-ink-500 focus:border-accent/60"
        >
          {layouts.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </label>

      {model && (
        <div className="hidden items-center gap-1.5 xl:flex">
          <span className="chip">{model.config.aisles} aisles</span>
          <span className="chip">{model.bins.length.toLocaleString()} bins</span>
          <span className="chip">{model.area.toLocaleString()} m²</span>
        </div>
      )}

      <div className="flex-1" />

      <div className="flex items-center gap-2">
        <div className="hidden text-right leading-tight lg:block">
          <div className="text-[9.5px] uppercase tracking-[0.12em] text-ink-400">Shift clock</div>
          <div className="font-mono text-[13px] font-semibold tabular-nums text-ink-100">
            {clock(metrics?.time ?? 0)}
          </div>
        </div>

        <div
          className={cx(
            'hidden items-center gap-1.5 rounded-lg border px-2 py-1 text-[10px] font-medium md:flex',
            running ? 'pill-good' : 'border-ink-600 bg-ink-800 text-ink-400',
          )}
        >
          <span
            className={cx('h-1.5 w-1.5 rounded-full', running ? 'animate-pulse bg-good' : 'bg-ink-500')}
          />
          {running ? 'Running' : orders.length === 0 ? 'No orders' : 'Paused'}
        </div>

        <Segmented value={timeScale} options={TIME_SCALES} onChange={setTimeScale} />

        <button
          type="button"
          onClick={() => (running ? pause() : start())}
          className={cx('btn min-w-[112px]', running ? '' : 'btn-primary')}
          disabled={orders.length === 0}
          title={orders.length === 0 ? 'Queue some orders first' : undefined}
        >
          {running ? '❙❙ Pause' : '▶ Run simulation'}
        </button>

        <button type="button" onClick={reset} className="btn" title="Reset clock, agents and metrics">
          ↺ Reset
        </button>

        <div className="mx-0.5 h-7 w-px bg-ink-700" />

        <div className="hidden text-right leading-tight 2xl:block">
          <div className="text-[9.5px] uppercase tracking-[0.12em] text-ink-400">Routing</div>
          <div className="text-[11px] font-medium text-accent-soft">{strategy.name}</div>
        </div>

        <button
          type="button"
          onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
          className="btn btn-icon"
          title={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme (t)`}
          aria-label="Toggle colour theme"
        >
          {theme === 'light' ? (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path
                d="M13.2 10.4A5.6 5.6 0 0 1 5.6 2.8a5.6 5.6 0 1 0 7.6 7.6Z"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
              <circle cx="8" cy="8" r="3.1" stroke="currentColor" strokeWidth="1.4" />
              <path
                d="M8 1.4v1.7M8 12.9v1.7M1.4 8h1.7M12.9 8h1.7M3.3 3.3l1.2 1.2M11.5 11.5l1.2 1.2M12.7 3.3l-1.2 1.2M4.5 11.5l-1.2 1.2"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          )}
        </button>

        <button
          type="button"
          onClick={() => toggle('rightOpen')}
          className={cx('btn btn-icon', rightOpen && 'text-accent-soft')}
          title="Toggle metrics panel"
        >
          ▤
        </button>
      </div>
    </header>
  )
}
