import { useEffect, useRef } from 'react'
import type { AgentMetrics, PickTask } from '../simulation/types'
import { useAppStore } from '../store/useAppStore'
import { Bar, Card, EmptyState, cx } from './components/primitives'
import { BoxIcon, CheckIcon, ChevronRightIcon, LocationIcon } from './components/icons'
import { PHASE_LABEL, PHASE_TONE, metres, pct, shortDuration } from './format'
import { chartPalette } from './theme'

const KIND_LABEL: Record<string, string> = {
  person: 'Hand tote',
  cart: 'Pick cart',
  palletJack: 'Pallet truck',
  amr: 'AMR robot',
}

/**
 * The picker flow, as the operator sees it.
 *
 * Everywhere else in this app a tour is an aggregate — distance, utilisation, a
 * progress bar. This is the other half: the actual instruction being worked
 * right now, in the format an RF terminal would hand it over (location, then
 * SKU, then quantity, in that order of prominence), followed by the rest of the
 * tour in visiting order.
 *
 * It follows the focused picker so the panel, the numbered markers on the floor
 * and the highlighted bins are all describing the same tour. Clicking a task
 * selects that location in the scene, which is what makes the list navigable
 * rather than decorative.
 */
export function PickFlowPanel() {
  const metrics = useAppStore((s) => s.metrics)
  const focusAgentId = useAppStore((s) => s.focusAgentId)
  const setFocusAgent = useAppStore((s) => s.setFocusAgent)
  const setSelection = useAppStore((s) => s.setSelection)
  const palette = chartPalette(useAppStore((s) => s.theme))

  const agents = metrics?.agents ?? []
  // Prefer the explicitly focused picker, then whoever is actually on a tour —
  // an empty panel while five pickers walk routes would be a bug, not a state.
  const agent =
    agents.find((a) => a.id === focusAgentId) ?? agents.find((a) => a.tasks.length > 0) ?? agents[0]

  if (!agent) return null

  return (
    <Card
      title="Pick task"
      dense
      action={
        <div className="flex items-center gap-1.5">
          {agents.length > 1 && (
            <div className="flex items-center gap-1">
              {agents.slice(0, 8).map((a) => (
                <button
                  key={a.id}
                  type="button"
                  title={`Follow ${a.label}`}
                  onClick={() => setFocusAgent(a.id)}
                  className={cx(
                    'grid h-4 w-4 place-items-center rounded text-[8.5px] font-bold transition-all duration-150',
                    a.id === agent.id ? 'text-ink-950' : 'text-ink-400 hover:text-ink-100',
                  )}
                  style={
                    a.id === agent.id
                      ? { background: a.color }
                      : { boxShadow: `inset 0 0 0 1px ${a.color}88` }
                  }
                >
                  {a.label.replace(/[^0-9]/g, '') || a.label}
                </button>
              ))}
            </div>
          )}
          <span className="chip">{KIND_LABEL[agent.kind] ?? agent.kind}</span>
        </div>
      }
    >
      <CurrentTask agent={agent} onSelect={setSelection} />
      <TaskList agent={agent} onSelect={setSelection} />
      <TimeSplit agent={agent} palette={palette} />
    </Card>
  )
}

function CurrentTask({
  agent,
  onSelect,
}: {
  agent: AgentMetrics
  onSelect: (s: { kind: 'bin'; id: string }) => void
}) {
  const current = agent.tasks.find((t) => t.status === 'current')
  const remaining = agent.tasks.filter((t) => t.status !== 'done').length

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span
          className="grid h-5 w-5 shrink-0 place-items-center rounded-md text-[9.5px] font-bold text-ink-950"
          style={{ background: agent.color }}
        >
          {agent.label}
        </span>
        <span className={cx('text-[11px] font-semibold', PHASE_TONE[agent.phase])}>
          {PHASE_LABEL[agent.phase]}
        </span>
        <span className="flex-1" />
        {agent.orderRefs.length > 0 && (
          <span className="truncate font-mono text-[9.5px] text-ink-400">
            {agent.orderRefs.join(' + ')}
          </span>
        )}
      </div>

      {current ? (
        <button
          type="button"
          onClick={() => onSelect({ kind: 'bin', id: current.binId })}
          className="w-full rounded-lg border border-accent/40 bg-gradient-to-br from-accent/10 to-accent-soft/5 px-2.5 py-2 text-left shadow-[inset_0_1px_1px_rgba(255,255,255,0.1),0_4px_12px_rgba(var(--accent)/0.2)] backdrop-blur-md transition-all hover:border-accent/60 hover:from-accent/15 hover:to-accent-soft/10"
          title="Show this location in the scene"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[9px] font-semibold uppercase tracking-[0.13em] text-ink-400">
              Stop {current.sequence} of {agent.tasks.length}
            </span>
            <span className="text-[9px] font-medium uppercase tracking-wider text-accent-soft">
              Aisle A{String(current.aisle + 1).padStart(2, '0')}
            </span>
          </div>

          <div className="mt-1 flex items-center gap-1.5">
            <LocationIcon size={13} className="shrink-0 text-accent-soft" />
            <span className="truncate font-mono text-[17px] font-semibold leading-none tracking-tight text-ink-100">
              {current.code}
            </span>
          </div>

          {/*
            * A bulk retrieval is the single most expensive stop on a tour, and
            * nothing about the code or the walk distance says so — the picker
            * stands in exactly the same place as for the shelf at knee height.
            * Calling it out here is what makes a slow tour explicable.
            */}
          <div className="mt-1.5 flex items-center gap-1">
            {current.reserve ? (
              <span className="chip !border-warn/45 !bg-warn/10 !text-[8.5px] !text-[var(--viz-warning)]">
                Reserve · L{current.levelInTier}
              </span>
            ) : (
              <span className="chip !text-[8.5px]">Pick face · L{current.levelInTier}</span>
            )}
          </div>

          <div className="mt-1.5 truncate text-[10.5px] font-medium text-ink-200">
            {current.skuName}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[9.5px] text-ink-400">
            <span>{current.sku}</span>
            <span className="text-ink-600">·</span>
            <span>{current.orderRef}</span>
          </div>

          <div className="mt-2 flex items-center gap-1.5 border-t border-accent/20 pt-1.5">
            <BoxIcon size={12} className="shrink-0 text-ink-400" />
            <span className="font-mono text-[13px] font-semibold tabular-nums text-ink-100">
              {current.qty}
            </span>
            <span className="text-[9.5px] text-ink-400">
              {current.qty === 1 ? 'unit to pick' : 'units to pick'}
            </span>
            <span className="flex-1" />
            <span className="text-[9.5px] text-ink-400">
              {remaining - 1 > 0 ? `${remaining - 1} more after this` : 'last stop'}
            </span>
          </div>
        </button>
      ) : (
        <EmptyState
          title={agent.tasks.length > 0 ? 'Tour complete' : 'No task assigned'}
          body={
            agent.tasks.length > 0
              ? 'Every line on this tour is picked — the picker is on its way to pack.'
              : 'The picker is waiting for dispatch. Release a wave and run the simulation.'
          }
        />
      )}

      {agent.tasks.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 flex justify-between text-[9.5px] text-ink-400">
            <span>
              {agent.stopsDone}/{agent.routeStops} lines picked
            </span>
            <span className="font-mono tabular-nums text-ink-200">
              {pct(agent.progress)} · {metres(agent.tourDistance)} of {metres(agent.routeDistance)}
            </span>
          </div>
          <Bar value={agent.progress} color={agent.color} />
        </div>
      )}
    </div>
  )
}

/**
 * The rest of the tour.
 *
 * Capped in height and auto-scrolled to whatever is being worked on, so a
 * 30-stop batched tour stays a glanceable panel instead of pushing every other
 * card off the rail.
 */
function TaskList({
  agent,
  onSelect,
}: {
  agent: AgentMetrics
  onSelect: (s: { kind: 'bin'; id: string }) => void
}) {
  const listRef = useRef<HTMLOListElement>(null)
  const currentSeq = agent.tasks.find((t) => t.status === 'current')?.sequence ?? 0

  // Scroll the list itself rather than calling `scrollIntoView`, which walks up
  // and scrolls every ancestor — including the metrics rail, which would jump
  // under the reader every time a picker finished a line.
  useEffect(() => {
    const list = listRef.current
    const row = list?.querySelector<HTMLElement>('[data-current="true"]')
    if (!list || !row) return
    const top = row.offsetTop - list.clientHeight / 2 + row.offsetHeight / 2
    list.scrollTop = Math.max(0, top)
  }, [currentSeq, agent.id])

  if (agent.tasks.length === 0) return null

  return (
    <div className="mt-3">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[9px] font-semibold uppercase tracking-[0.13em] text-ink-400">
          Task list
        </span>
        <span className="font-mono text-[9px] text-ink-500">visiting order</span>
      </div>
      {/* `relative` so a row's `offsetTop` is measured against the list, which is
          what the auto-scroll above assumes. */}
      <ol
        ref={listRef}
        className="relative max-h-[168px] space-y-px overflow-y-auto rounded-lg border border-ink-700/50 bg-ink-850/20 p-1 shadow-inner backdrop-blur-sm"
      >
        {agent.tasks.map((task) => (
          <TaskRow key={`${task.sequence}-${task.binId}`} task={task} color={agent.color} onSelect={onSelect} />
        ))}
      </ol>
    </div>
  )
}

function TaskRow({
  task,
  color,
  onSelect,
}: {
  task: PickTask
  color: string
  onSelect: (s: { kind: 'bin'; id: string }) => void
}) {
  const done = task.status === 'done'
  const current = task.status === 'current'

  return (
    <li data-current={current}>
      <button
        type="button"
        onClick={() => onSelect({ kind: 'bin', id: task.binId })}
        title={`${task.skuName} — ${task.orderRef}`}
        className={cx(
          'flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-all duration-200',
          current ? 'bg-gradient-to-r from-accent/15 to-transparent shadow-[inset_2px_0_0_rgb(var(--accent))]' : 'hover:bg-ink-750/40 hover:shadow-sm',
        )}
      >
        <span
          className={cx(
            'grid h-4 w-4 shrink-0 place-items-center rounded font-mono text-[8.5px] font-bold tabular-nums',
            done
              ? 'bg-ink-700/60 text-ink-400'
              : current
                ? 'text-ink-950'
                : 'bg-ink-750 text-ink-300',
          )}
          style={current ? { background: color } : undefined}
        >
          {done ? <CheckIcon size={9} /> : task.sequence}
        </span>

        <span
          className={cx(
            'flex-1 truncate font-mono text-[10px]',
            done ? 'text-ink-500 line-through decoration-ink-600' : current ? 'text-ink-100' : 'text-ink-300',
          )}
        >
          {task.code}
        </span>

        <span
          className={cx(
            'shrink-0 font-mono text-[9.5px] tabular-nums',
            done ? 'text-ink-500' : 'text-ink-300',
          )}
        >
          {task.qty} ea
        </span>

        {current ? (
          <ChevronRightIcon size={10} className="shrink-0 text-accent-soft" />
        ) : (
          <span className="w-[10px] shrink-0" />
        )}
      </button>
    </li>
  )
}

/**
 * Where the shift actually went.
 *
 * Walking / picking / waiting / idle as one stacked bar, because the ratio is
 * the diagnosis: a long walk share is a slotting or routing problem, a long wait
 * share is a pack-line or congestion problem, and utilisation on its own tells
 * you neither. Direct value labels are on the legend rows, so the segments never
 * have to be read by colour alone.
 */
function TimeSplit({
  agent,
  palette,
}: {
  agent: AgentMetrics
  palette: ReturnType<typeof chartPalette>
}) {
  const segments = [
    { key: 'walk', label: 'Walking', value: agent.walkTime, color: palette.series[0] },
    { key: 'pick', label: 'Picking', value: agent.pickTime, color: palette.series[1] },
    { key: 'wait', label: 'Waiting', value: agent.waitTime, color: palette.warning },
    { key: 'idle', label: 'Idle / break', value: agent.idleTime + agent.breakTime, color: palette.muted },
  ]
  const total = segments.reduce((s, seg) => s + seg.value, 0)
  if (total < 1) return null

  return (
    <div className="mt-3">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[9px] font-semibold uppercase tracking-[0.13em] text-ink-400">
          Where the shift went
        </span>
        <span className="font-mono text-[9px] text-ink-500">{shortDuration(total)} on shift</span>
      </div>

      <div className="flex h-2 w-full overflow-hidden rounded-full bg-ink-700">
        {segments.map((seg) => (
          <span
            key={seg.key}
            className="h-full transition-[width] duration-300"
            style={{ width: `${(seg.value / total) * 100}%`, background: seg.color }}
          />
        ))}
      </div>

      <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1">
        {segments.map((seg) => (
          <div key={seg.key} className="flex items-center gap-1.5 text-[9.5px]">
            <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: seg.color }} />
            <span className="truncate text-ink-400">{seg.label}</span>
            <span className="flex-1" />
            <span className="shrink-0 font-mono tabular-nums text-ink-200">
              {pct(seg.value / total)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
