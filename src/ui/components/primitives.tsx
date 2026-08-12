import type { ReactNode } from 'react'

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

export function Card({
  title,
  action,
  children,
  className,
  dense,
}: {
  title?: string
  action?: ReactNode
  children: ReactNode
  className?: string
  dense?: boolean
}) {
  return (
    <section className={cx('panel', className)}>
      {title && (
        <header className="panel-header">
          <h3 className="panel-title">{title}</h3>
          {action}
        </header>
      )}
      <div className={dense ? 'p-2.5' : 'p-3.5'}>{children}</div>
    </section>
  )
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  suffix,
  format,
  onChange,
  hint,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  suffix?: string
  format?: (v: number) => string
  onChange: (v: number) => void
  hint?: string
}) {
  return (
    <label className="block space-y-1.5">
      <span className="field-label">
        <span>{label}</span>
        <span className="field-value">
          {format ? format(value) : value}
          {suffix}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint && <span className="block text-[10px] leading-snug text-ink-400">{hint}</span>}
    </label>
  )
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  size = 'md',
}: {
  value: T
  options: { value: T; label: string; title?: string }[]
  onChange: (v: T) => void
  size?: 'sm' | 'md'
}) {
  return (
    <div className="inline-flex rounded-lg border border-ink-700/60 bg-ink-850/40 p-0.5 shadow-inner backdrop-blur-sm">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          title={opt.title}
          onClick={() => onChange(opt.value)}
          className={cx(
            'rounded-md font-medium transition-all duration-150',
            size === 'sm' ? 'px-2 py-[3px] text-[10px]' : 'px-2.5 py-1 text-[11px]',
            value === opt.value ? 'option-active text-accent-soft' : 'text-ink-400 hover:text-ink-200',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

export function Toggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  hint?: string
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-3 rounded-lg px-1 py-1 text-left transition-colors hover:bg-ink-750/40"
    >
      <span>
        <span className="block text-[11px] font-medium text-ink-200">{label}</span>
        {hint && <span className="block text-[10px] text-ink-400">{hint}</span>}
      </span>
      <span
        className={cx(
          'relative h-4 w-7 shrink-0 rounded-full transition-colors duration-200',
          checked ? 'bg-accent/70' : 'bg-ink-600',
        )}
      >
        <span
          className={cx(
            'absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform duration-200',
            checked ? 'translate-x-[15px]' : 'translate-x-0.5',
          )}
        />
      </span>
    </button>
  )
}

export function StatTile({
  label,
  value,
  unit,
  sub,
  tone = 'default',
}: {
  label: string
  value: string
  unit?: string
  sub?: string
  tone?: 'default' | 'accent' | 'good' | 'warn'
}) {
  const toneClass =
    tone === 'accent'
      ? 'text-accent-soft'
      : tone === 'good'
        ? 'text-[var(--viz-good)]'
        : tone === 'warn'
          ? 'text-[var(--viz-warning)]'
          : 'text-ink-100'
  return (
    <div className="rounded-lg border border-ink-700/50 bg-ink-850/30 px-2.5 py-2 shadow-[inset_0_1px_1px_rgba(255,255,255,0.05),0_2px_4px_rgba(0,0,0,0.1)] backdrop-blur-sm transition-colors hover:bg-ink-800/40">
      <div className="stat-label">{label}</div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className={cx('stat-value', toneClass)}>{value}</span>
        {unit && <span className="text-[10px] font-medium text-ink-400">{unit}</span>}
      </div>
      {sub && <div className="mt-0.5 truncate text-[10px] text-ink-400">{sub}</div>}
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode
  title: string
  body?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-ink-700/60 bg-ink-850/20 px-4 py-6 text-center backdrop-blur-sm transition-colors hover:bg-ink-850/30">
      {icon && <div className="text-ink-500">{icon}</div>}
      <div className="text-xs font-medium text-ink-200">{title}</div>
      {body && <p className="max-w-[24ch] text-[10.5px] leading-relaxed text-ink-400">{body}</p>}
      {action}
    </div>
  )
}

export function Bar({ value, color }: { value: number; color: string }) {
  return (
    <span className="block h-1 w-full overflow-hidden rounded-full bg-ink-700">
      <span
        className="block h-full rounded-full transition-[width] duration-200"
        style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, background: color }}
      />
    </span>
  )
}
