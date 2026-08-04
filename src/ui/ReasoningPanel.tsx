import type { AgentMetrics, Thought } from '../simulation/types'
import { useAppStore } from '../store/useAppStore'
import { Card, EmptyState, cx } from './components/primitives'

const KIND_STYLE: Record<Thought['kind'], { label: string; tone: string; glyph: string }> = {
  dispatch: { label: 'Took order', tone: 'text-[var(--viz-series-1)]', glyph: '↦' },
  batch: { label: 'Batched', tone: 'text-[var(--viz-series-3)]', glyph: '⊕' },
  plan: { label: 'Planned', tone: 'text-accent-soft', glyph: '⤳' },
  reroute: { label: 'Re-routed', tone: 'text-[var(--viz-series-2)]', glyph: '↻' },
  wait: { label: 'Waiting', tone: 'text-[var(--viz-warning)]', glyph: '‖' },
  short: { label: 'Short pick', tone: 'text-[var(--viz-critical)]', glyph: '!' },
  break: { label: 'Break', tone: 'text-ink-400', glyph: '☕' },
  done: { label: 'Dropped off', tone: 'text-[var(--viz-good)]', glyph: '✓' },
}

/**
 * The picker's reasoning trace.
 *
 * Every non-trivial decision the engine makes — dispatch choice, batching,
 * re-routing around congestion, short picks, breaks — is recorded with the
 * numbers behind it, so you can see *why* a picker did something instead of
 * inferring it from the animation.
 */
export function ReasoningPanel() {
  const metrics = useAppStore((s) => s.metrics)
  const focusAgentId = useAppStore((s) => s.focusAgentId)
  const setSelection = useAppStore((s) => s.setSelection)
  const setFocusAgent = useAppStore((s) => s.setFocusAgent)

  const agents = metrics?.agents ?? []
  const focused: AgentMetrics | undefined =
    agents.find((a) => a.id === focusAgentId) ?? agents.find((a) => a.thoughts.length > 0) ?? agents[0]

  return (
    <Card
      title="Picker reasoning"
      dense
      action={
        agents.length > 1 ? (
          // Wraps, because the fleet can run well past eight pickers.
          <div className="flex max-w-[190px] flex-wrap justify-end gap-1">
            {agents.map((a) => (
              <button
                key={a.id}
                type="button"
                title={`Show ${a.label}'s reasoning`}
                onClick={() => {
                  setFocusAgent(a.id)
                  setSelection({ kind: 'agent', id: a.id })
                }}
                className={cx(
                  // min-w rather than fixed w, so P10+ still fits its label.
                  'grid h-4 min-w-4 place-items-center rounded px-[3px] text-[8.5px] font-bold tabular-nums transition-opacity',
                  focused?.id === a.id ? 'opacity-100' : 'opacity-35 hover:opacity-70',
                )}
                style={{ background: a.color, color: 'rgb(var(--ink-950))' }}
              >
                {a.label.replace('P', '')}
              </button>
            ))}
          </div>
        ) : null
      }
    >
      {!focused || focused.thoughts.length === 0 ? (
        <EmptyState
          title="No decisions yet"
          body="Run the simulation — each dispatch, batch and re-route is logged here with the numbers behind it."
        />
      ) : (
        <div>
          <div className="mb-2 flex items-center gap-2">
            <span
              className="grid h-5 w-5 place-items-center rounded-md text-[9.5px] font-bold text-ink-950"
              style={{ background: focused.color }}
            >
              {focused.label}
            </span>
            <span className="text-[10.5px] text-ink-300">
              {focused.linesLoaded > 0
                ? `carrying ${focused.linesLoaded}/${focused.capacityLines} lines`
                : `empty · ${focused.capacityLines}-line capacity`}
            </span>
            {focused.orderRefs.length > 1 && (
              <span className="chip !text-[9px]">batch ×{focused.orderRefs.length}</span>
            )}
          </div>

          <ol className="space-y-1.5">
            {focused.thoughts.map((thought, i) => {
              const style = KIND_STYLE[thought.kind]
              return (
                <li
                  key={thought.id}
                  className={cx(
                    'rounded-lg border px-2 py-1.5 transition-colors',
                    i === 0
                      ? 'border-ink-600 bg-ink-750/60'
                      : 'border-ink-700/50 bg-ink-850/40 opacity-80',
                  )}
                >
                  <div className="flex items-baseline gap-1.5">
                    <span className={cx('shrink-0 text-[10px] font-bold', style.tone)}>
                      {style.glyph}
                    </span>
                    <span className={cx('shrink-0 text-[9px] font-semibold uppercase tracking-wider', style.tone)}>
                      {style.label}
                    </span>
                    <span className="ml-auto shrink-0 font-mono text-[9px] tabular-nums text-ink-500">
                      {clockShort(thought.at)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[10px] leading-snug text-ink-200">{thought.text}</p>
                </li>
              )
            })}
          </ol>
        </div>
      )}
    </Card>
  )
}

function clockShort(seconds: number): string {
  const s = Math.floor(seconds)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
