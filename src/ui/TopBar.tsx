import { getStrategy } from '../pathfinding/strategies'
import { useAppStore } from '../store/useAppStore'
import { isReserveLevel } from '../warehouse/rackGeometry'
import { cx } from './components/primitives'
import { clock } from './format'
import {
  MoonIcon,
  PanelLeftIcon,
  PanelRightIcon,
  RackMarkIcon,
  SunIcon,
} from './components/icons'

/**
 * One facility fact in the chrome: the number carries the weight, the unit
 * recedes. Was a flat `.chip` per stat, where "8", "2,560" and "3,427" all sat
 * at label weight and the row read as undifferentiated grey text.
 */
function FacilityStat({ value, label, title }: { value: string; label: string; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex items-baseline gap-1.5 rounded-md border border-accent/20 bg-gradient-to-br from-accent/5 to-ink-800 px-2 py-0.5 shadow-[inset_0_1px_1px_rgba(255,255,255,0.05),0_2px_4px_rgb(var(--accent)/0.1)] transition-colors hover:border-accent/40 hover:from-accent/10 hover:to-ink-800"
    >
      <span className="font-mono text-[11px] font-bold tabular-nums leading-none text-ink-100">
        {value}
      </span>
      <span className="text-[9px] font-semibold uppercase tracking-widest text-ink-400">{label}</span>
    </span>
  )
}

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
  const pickFaceBins = model
    ? model.bins.reduce((n, b) => n + (isReserveLevel(model.config, b.level) ? 0 : 1), 0)
    : 0
  const reserveBins = model ? model.bins.length - pickFaceBins : 0

  return (
    <header className="z-30 flex h-14 shrink-0 items-center gap-3 border-b border-accent/40 bg-gradient-to-r from-accent/15 via-ink-900 to-accent-soft/15 px-3 shadow-[0_4px_32px_-12px_rgb(var(--accent)/0.3)] backdrop-blur-md">
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
          className="grid h-8 w-8 place-items-center rounded-lg text-white shadow-[0_2px_10px_0_rgb(var(--accent)/0.3)] ring-1 ring-white/10 transition-transform duration-300 hover:scale-105"
          style={{ background: 'linear-gradient(135deg, rgb(var(--accent-soft)), rgb(var(--accent)))' }}
        >
          {/* Racking mark — two shelf bays, the product's logo. */}
          <RackMarkIcon />
        </div>
        <div className="leading-tight">
          <div className="text-[13px] font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-ink-100 to-ink-300">Digital Twin WMS</div>
          <div className="text-[10px] font-medium text-ink-400">Warehouse Management System</div>
        </div>
      </div>

      <div className="mx-1 h-7 w-px bg-ink-700" />

      <label className="flex items-center gap-2">
        <span className="sr-only">Warehouse layout</span>
        <select
          value={layoutId}
          onChange={(e) => selectLayout(e.target.value)}
          /*
           * `text-xs` was the only use of Tailwind's default type scale in the
           * chrome; everything around it is on the app's own bracket scale, so
           * it rendered a step larger than its neighbours. Focus-visible is
           * borrowed from `.btn` so keyboard focus is as clear here as on
           * every other control in this bar.
           */
          className="rounded-lg border border-ink-600 bg-ink-800 px-2.5 py-1.5 text-[11.5px] font-medium text-ink-100 outline-none transition-colors hover:border-ink-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
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
          <FacilityStat value={String(model.config.aisles)} label="aisles" />
          {/*
            * Split rather than one total: the two tiers are stocked and worked
            * so differently that a single "3,840 bins" hides the thing worth
            * knowing about this facility — how much of it is reachable on foot.
            */}
          <FacilityStat
            value={pickFaceBins.toLocaleString()}
            label="pick face"
            title={`${pickFaceBins.toLocaleString()} case-pick locations, reachable on foot`}
          />
          {reserveBins > 0 && (
            <FacilityStat
              value={reserveBins.toLocaleString()}
              label="bulk"
              title={`${reserveBins.toLocaleString()} pallet positions in the reserve tier above the pick face`}
            />
          )}
          <FacilityStat value={model.area.toLocaleString()} label="m²" />
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
            <div className="mini-label">Shift</div>
            <div className="font-mono text-[12px] font-semibold tabular-nums text-ink-100">
              {clock(metrics.time)}
            </div>
          </div>

          <div className="hidden leading-tight lg:block">
            <div className="mini-label">Shipped</div>
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
          <div className="mini-label">Routing</div>
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
