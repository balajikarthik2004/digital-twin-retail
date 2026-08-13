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
  { id: 'ops', label: 'Operations', hint: 'Fleet, pack-out and scene options', Icon: SlidersIcon },
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
      className="relative flex shrink-0 gap-1 rounded-b-xl border-t border-ink-700 bg-ink-850 px-2 pt-1.5"
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
              'relative flex-1 rounded-t-lg px-1 pb-2.5 pt-2 transition-colors duration-150',
              'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
              active ? 'text-accent-soft' : 'text-ink-400 hover:bg-ink-750 hover:text-ink-100',
            )}
          >
            <s.Icon
              size={16}
              className={cx('mx-auto block', active ? 'text-accent-soft' : 'text-ink-500')}
            />
            <span className="mt-1.5 block text-[10px] font-semibold leading-none">{s.label}</span>
            {/*
              * Ties the selected tab to the panel it opens, and is now the
              * *only* thing marking it. A tinted card behind the active tab
              * fought the cards in the panel below for the same emphasis; a
              * rule on the shared border reads as one continuous surface —
              * this tab opens onto that.
              */}
            {active && (
              <span className="absolute inset-x-2 -bottom-px h-[2px] rounded-full bg-accent" />
            )}
            {badge > 0 && (
              <span
                className={cx(
                  'absolute right-1 top-0.5 min-w-[16px] rounded-full px-1 font-mono text-[8.5px] font-bold leading-4',
                  // Waiting work on the tab you are already looking at is
                  // context; on a tab you are not, it is a prompt to go there.
                  active
                    ? 'bg-accent text-[rgb(var(--on-accent))]'
                    : 'bg-ink-700 text-ink-200',
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
