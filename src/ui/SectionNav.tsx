import { useAppStore, type AppSection } from '../store/useAppStore'
import { cx } from './components/primitives'

/**
 * Left-sidebar section switcher.
 *
 * The order is the physical flow of goods, left to right: set the shift up,
 * take stock in, send orders out, then review what happened.
 */
const SECTIONS: { id: AppSection; label: string; hint: string; glyph: string }[] = [
  { id: 'ops', label: 'Ops', hint: 'Fleet, pack-out and scene options', glyph: '⚙' },
  { id: 'inbound', label: 'Inbound', hint: 'Goods-in, free space and putaway', glyph: '↓' },
  { id: 'outbound', label: 'Outbound', hint: 'Order waves and the pick queue', glyph: '↑' },
  { id: 'history', label: 'History', hint: 'Everything received and shipped', glyph: '↻' },
]

export function SectionNav() {
  const section = useAppStore((s) => s.section)
  const setSection = useAppStore((s) => s.setSection)

  // Badges: work waiting in each section, so a tab is never a blind alley.
  // Inbound counts delivery lines still to count in or put away.
  const pendingLines = useAppStore((s) =>
    s.receipts.reduce((t, r) => t + r.lines.filter((l) => l.status !== 'stored').length, 0),
  )
  const queued = useAppStore((s) => s.metrics?.ordersPending ?? 0)

  const badgeFor = (id: AppSection) =>
    id === 'inbound' ? pendingLines : id === 'outbound' ? queued : 0

  return (
    <nav
      className="flex shrink-0 gap-0.5 border-b border-ink-700 bg-ink-900 px-2 pb-2 pt-1.5"
      aria-label="Workspace sections"
    >
      {SECTIONS.map((s) => {
        const active = section === s.id
        const badge = badgeFor(s.id)
        return (
          <button
            key={s.id}
            type="button"
            title={s.hint}
            aria-current={active ? 'page' : undefined}
            onClick={() => setSection(s.id)}
            className={cx(
              'relative flex-1 rounded-lg border px-1 py-1.5 transition-all duration-150',
              active
                ? 'option-active'
                : 'border-transparent text-ink-400 hover:bg-ink-750 hover:text-ink-100',
            )}
          >
            <span
              className={cx(
                'block text-[13px] leading-none',
                active ? 'text-accent-soft' : 'text-ink-500',
              )}
              aria-hidden
            >
              {s.glyph}
            </span>
            <span
              className={cx(
                'mt-1 block text-[10px] font-semibold leading-none',
                active ? 'text-accent-soft' : 'text-ink-400',
              )}
            >
              {s.label}
            </span>
            {badge > 0 && (
              <span
                className="absolute right-1 top-0.5 rounded-full bg-ink-600 px-1 font-mono text-[8.5px] font-bold leading-[14px] text-ink-100"
                title={`${badge} waiting`}
              >
                {badge > 99 ? '99+' : badge}
              </span>
            )}
          </button>
        )
      })}
    </nav>
  )
}
