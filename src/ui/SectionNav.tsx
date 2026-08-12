import type { ComponentType, SVGProps } from 'react'
import { useAppStore, type AppSection } from '../store/useAppStore'
import { cx } from './components/primitives'
import { HistoryIcon, InboundIcon, OutboundIcon, SlidersIcon } from './components/icons'

/**
 * Left-sidebar section switcher.
 *
 * The order is the physical flow of goods, left to right: set the shift up,
 * take stock in, send orders out, then review what happened.
 */
const SECTIONS: {
  id: AppSection
  label: string
  hint: string
  Icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number }>
}[] = [
  { id: 'ops', label: 'Ops', hint: 'Fleet, pack-out and scene options', Icon: SlidersIcon },
  { id: 'inbound', label: 'Inbound', hint: 'Goods-in, free space and putaway', Icon: InboundIcon },
  { id: 'outbound', label: 'Outbound', hint: 'Order waves and the pick queue', Icon: OutboundIcon },
  { id: 'history', label: 'History', hint: 'Everything received and shipped', Icon: HistoryIcon },
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
      className="relative flex shrink-0 gap-0.5 border-b border-accent/20 bg-transparent px-2 pb-1.5 pt-1.5"
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
              'relative flex-1 rounded-lg border px-1 pb-2 pt-1.5 transition-all duration-200',
              'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
              active
                ? 'option-active shadow-sm backdrop-blur-sm'
                : 'border-transparent text-ink-400 hover:bg-ink-750/50 hover:text-ink-100 hover:shadow-sm',
            )}
          >
            <s.Icon
              size={15}
              className={cx('mx-auto block', active ? 'text-accent-soft' : 'text-ink-500')}
            />
            <span
              className={cx(
                'mt-1 block text-[10px] font-semibold leading-none',
                active ? 'text-accent-soft' : 'text-ink-400',
              )}
            >
              {s.label}
            </span>
            {/*
              * Ties the selected tab to the panel it opens. Without it the tab
              * strip and the section under it read as two unrelated bands —
              * the active tab was tinted, but nothing pointed at what it had
              * actually switched.
              */}
            {active && (
              <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-accent" />
            )}
            {badge > 0 && (
              <span
                className={cx(
                  'absolute right-1 top-0.5 min-w-[15px] rounded-full px-1 font-mono text-[8.5px] font-bold leading-[15px]',
                  // Waiting work on the tab you are already looking at is
                  // context; on a tab you are not, it is a prompt to go there.
                  active ? 'bg-accent text-ink-900' : 'bg-ink-600 text-ink-100',
                )}
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
