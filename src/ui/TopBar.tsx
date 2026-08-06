import { getStrategy } from '../pathfinding/strategies'
import { useAppStore } from '../store/useAppStore'
import { cx } from './components/primitives'
import { clock } from './format'
import {
  MoonIcon,
  PanelLeftIcon,
  PanelRightIcon,
  RackMarkIcon,
  SunIcon,
} from './components/icons'

export function TopBar() {
  const layouts = useAppStore((s) => s.layouts)
  const layoutId = useAppStore((s) => s.layoutId)
  const model = useAppStore((s) => s.model)
  const settings = useAppStore((s) => s.settings)
  const leftOpen = useAppStore((s) => s.leftOpen)
  const rightOpen = useAppStore((s) => s.rightOpen)
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)
  const metrics = useAppStore((s) => s.metrics)

  const selectLayout = useAppStore((s) => s.selectLayout)
  const toggle = useAppStore((s) => s.toggle)

  const strategy = getStrategy(settings.strategyId)

  return (
    <header className="z-30 flex h-14 shrink-0 items-center gap-3 border-b border-ink-700 bg-ink-900 px-3 shadow-panel">
      <button
        type="button"
        onClick={() => toggle('leftOpen')}
        className={cx('btn btn-icon', leftOpen && 'text-accent-soft')}
        title="Toggle controls panel ([)"
        aria-label="Toggle controls panel"
      >
        <PanelLeftIcon />
      </button>

      <div className="flex items-center gap-2.5">
        <div
          className="grid h-8 w-8 place-items-center rounded-lg text-white shadow-sm"
          style={{ background: 'rgb(var(--accent))' }}
        >
          {/* Racking mark — two shelf bays, the product's logo. */}
          <RackMarkIcon />
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

      {/*
        Shift status, always on. Both side panels can be collapsed for a clean
        look at the floor, and an operations view that cannot tell you whether the
        shift is even running is not one — so the clock, the run state and the
        headline count live in the chrome as well as in the panels.
      */}
      {metrics && (
        <div className="mr-1 flex items-center gap-2.5">
          <span
            className={cx(
              'inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[10px] font-medium',
              metrics.running ? 'pill-good' : 'border-ink-600 bg-ink-800 text-ink-400',
            )}
          >
            <span
              className={cx(
                'h-1.5 w-1.5 rounded-full',
                metrics.running ? 'animate-pulse bg-good' : 'bg-ink-500',
              )}
            />
            {metrics.running ? 'Running' : metrics.time > 0 ? 'Paused' : 'Ready'}
          </span>

          <div className="leading-tight">
            <div className="text-[9px] uppercase tracking-[0.12em] text-ink-400">Shift</div>
            <div className="font-mono text-[12px] font-semibold tabular-nums text-ink-100">
              {clock(metrics.time)}
            </div>
          </div>

          <div className="hidden leading-tight lg:block">
            <div className="text-[9px] uppercase tracking-[0.12em] text-ink-400">Shipped</div>
            <div className="font-mono text-[12px] font-semibold tabular-nums text-ink-100">
              {metrics.ordersCompleted}
              <span className="text-ink-400">/{metrics.ordersTotal}</span>
            </div>
          </div>

          <div className="mx-0.5 h-7 w-px bg-ink-700" />
        </div>
      )}

      <div className="flex items-center gap-2">
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
          {theme === 'light' ? <MoonIcon /> : <SunIcon />}
        </button>

        <button
          type="button"
          onClick={() => toggle('rightOpen')}
          className={cx('btn btn-icon', rightOpen && 'text-accent-soft')}
          title="Toggle metrics panel (])"
          aria-label="Toggle metrics panel"
        >
          <PanelRightIcon />
        </button>
      </div>
    </header>
  )
}
