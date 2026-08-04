import { useAppStore } from '../store/useAppStore'
import { Bar, Card, EmptyState, StatTile, cx } from './components/primitives'
import {
  ComparisonTable,
  DistanceComparisonChart,
  TimeBreakdownChart,
} from './charts/ComparisonCharts'
import { ThroughputChart } from './charts/ThroughputChart'
import { ReasoningPanel } from './ReasoningPanel'
import { PHASE_LABEL, PHASE_TONE, metres, mmss, pct } from './format'
import { chartPalette } from './theme'

export function MetricsPanel() {
  const metrics = useAppStore((s) => s.metrics)
  const orders = useAppStore((s) => s.orders)
  const comparison = useAppStore((s) => s.comparison)
  const comparing = useAppStore((s) => s.comparing)
  const settings = useAppStore((s) => s.settings)
  const focusAgentId = useAppStore((s) => s.focusAgentId)
  const runComparison = useAppStore((s) => s.runComparison)
  const clearComparison = useAppStore((s) => s.clearComparison)
  const setSelection = useAppStore((s) => s.setSelection)
  const setFocusAgent = useAppStore((s) => s.setFocusAgent)
  const palette = chartPalette(useAppStore((s) => s.theme))

  if (!metrics) {
    return (
      <div className="p-3">
        <Card title="Live metrics">
          <EmptyState title="Warming up" body="Metrics appear as soon as the twin is initialised." />
        </Card>
      </div>
    )
  }

  const started = metrics.time > 0
  const totalLines = orders.reduce((s, o) => s + o.lines.length, 0)
  const idleCount = metrics.agents.filter((a) => a.phase === 'idle').length

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <Card title="Wave summary" dense>
        <div className="grid grid-cols-2 gap-2">
          <StatTile
            label="Orders completed"
            value={String(metrics.ordersCompleted)}
            sub={`of ${metrics.ordersTotal} in wave`}
            tone="accent"
          />
          <StatTile
            label="Distance walked"
            value={metres(metrics.totalDistance)}
            sub={
              metrics.ordersCompleted > 0
                ? `${metres(metrics.avgDistancePerOrder)} per order`
                : 'across all pickers'
            }
          />
          <StatTile
            label="Avg time / order"
            value={metrics.ordersCompleted > 0 ? mmss(metrics.avgOrderTime) : '—'}
            sub={`${metrics.totalPicks} lines picked`}
          />
          <StatTile
            label="Throughput"
            value={started ? metrics.throughput.toFixed(1) : '—'}
            unit="orders/h"
            sub={started ? `${metrics.linesPerHour.toFixed(0)} lines/h` : 'not started'}
          />
        </div>

        <div className="mt-2.5 space-y-2">
          <ProgressRow
            label="Wave progress"
            value={metrics.ordersTotal > 0 ? metrics.ordersCompleted / metrics.ordersTotal : 0}
            right={`${metrics.ordersCompleted}/${metrics.ordersTotal}`}
            color={palette.series[0]}
          />
          <ProgressRow
            label="Fleet utilisation"
            value={metrics.utilisation}
            right={pct(metrics.utilisation)}
            color={palette.series[2]}
          />
          {/* Empty bar until something completes — a full green bar next to a
              "—" label would imply 100% attainment on zero orders. */}
          <ProgressRow
            label="On time vs SLA"
            value={metrics.ordersCompleted > 0 ? metrics.onTimeRate : 0}
            right={
              metrics.ordersCompleted > 0
                ? `${pct(metrics.onTimeRate)}${metrics.ordersLate > 0 ? ` · ${metrics.ordersLate} late` : ''}`
                : '—'
            }
            color={metrics.onTimeRate < 0.9 ? palette.critical : palette.good}
          />
        </div>

        <div className="mt-2.5 grid grid-cols-3 gap-2 text-center">
          <MiniStat label="Queued" value={metrics.ordersPending} />
          <MiniStat label="In progress" value={metrics.ordersInProgress} />
          <MiniStat
            label="Congestion"
            value={metrics.congestionEvents}
            tone={metrics.congestionEvents > 0 ? 'warn' : 'default'}
          />
        </div>

        {/* Behaviours only worth showing once they've actually fired. */}
        <div className="mt-2 grid grid-cols-4 gap-2 text-center">
          <MiniStat
            label="Batches"
            value={metrics.batchedTours}
            hint={metrics.avgBatchSize > 0 ? `avg ×${metrics.avgBatchSize.toFixed(1)}` : undefined}
          />
          <MiniStat label="Re-routes" value={metrics.reroutes} />
          <MiniStat
            label="Shorts"
            value={metrics.shortPicks}
            tone={metrics.shortPicks > 0 ? 'warn' : 'default'}
          />
          <MiniStat
            label="Replen"
            value={metrics.replenAlerts}
            tone={metrics.replenAlerts > 0 ? 'warn' : 'default'}
          />
        </div>

        {metrics.totalPlanned > 0 && (
          <p className="mt-2 text-[9.5px] leading-snug text-ink-400">
            Completed tours walked {metres(metrics.totalActual)} against {metres(metrics.totalPlanned)}{' '}
            planned —{' '}
            <span
              className={
                metrics.totalActual > metrics.totalPlanned * 1.02
                  ? 'text-[var(--viz-warning)]'
                  : 'text-[var(--viz-good)]'
              }
            >
              {`${(((metrics.totalActual - metrics.totalPlanned) / metrics.totalPlanned) * 100).toFixed(1)}%`}
            </span>{' '}
            drift from re-routes.
          </p>
        )}
      </Card>

      <ReasoningPanel />

      <Card
        title="Pickers"
        dense
        action={
          <span className="chip">
            {metrics.agents.length} on floor
            {idleCount > 0 ? ` · ${idleCount} idle` : ''}
          </span>
        }
      >
        {metrics.agents.length === 0 ? (
          <EmptyState title="No pickers assigned" />
        ) : (
          <div className="space-y-1.5">
            {metrics.agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => {
                  setSelection({ kind: 'agent', id: agent.id })
                  setFocusAgent(agent.id)
                }}
                className={cx(
                  'w-full rounded-lg border px-2.5 py-2 text-left transition-all duration-150',
                  focusAgentId === agent.id
                    ? 'border-ink-500 bg-ink-750/70'
                    : 'border-ink-700/70 bg-ink-850/50 hover:border-ink-600 hover:bg-ink-750/50',
                )}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="grid h-5 w-5 shrink-0 place-items-center rounded-md text-[9.5px] font-bold text-ink-950"
                    style={{ background: agent.color }}
                  >
                    {agent.label}
                  </span>
                  <span className={cx('text-[11px] font-medium', PHASE_TONE[agent.phase])}>
                    {PHASE_LABEL[agent.phase]}
                  </span>
                  <span className="flex-1" />
                  <span className="font-mono text-[10px] tabular-nums text-ink-300">
                    {metres(agent.distance)}
                  </span>
                </div>

                <div className="mt-1.5">
                  <Bar value={agent.progress} color={agent.color} />
                </div>

                <div className="mt-1.5 flex items-center justify-between gap-2 text-[9.5px] text-ink-400">
                  <span className="truncate font-mono">
                    {agent.orderRefs.length > 0 ? agent.orderRefs.join(' + ') : 'awaiting order'}
                  </span>
                  <span className="shrink-0">
                    {agent.routeStops > 0 ? `${agent.stopsDone}/${agent.routeStops} picks · ` : ''}
                    {agent.orders} done
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </Card>

      <Card title="Throughput" dense>
        {started ? (
          <ThroughputChart metrics={metrics} />
        ) : (
          <EmptyState
            title="Simulation not started"
            body="Press Run simulation to release the wave and start plotting throughput."
          />
        )}
      </Card>

      <Card
        title="Strategy comparison"
        action={
          comparison ? (
            <button type="button" onClick={clearComparison} className="btn btn-icon" title="Clear">
              ✕
            </button>
          ) : null
        }
        dense
      >
        {comparison ? (
          <div className="space-y-4">
            <DistanceComparisonChart rows={comparison} activeStrategyId={settings.strategyId} />
            <TimeBreakdownChart rows={comparison} />
            <ComparisonTable rows={comparison} activeStrategyId={settings.strategyId} />
            <p className="text-[9.5px] leading-relaxed text-ink-400">
              Every strategy routes the same {comparison[0]?.orders ?? 0} orders (
              {comparison[0]?.lines ?? 0} lines) from the same start point, so the only variable is
              visiting order. Times are modelled from distance, handling and pack-out — congestion
              waiting is excluded.
            </p>
            <button type="button" onClick={runComparison} className="btn w-full" disabled={comparing}>
              Re-run comparison
            </button>
          </div>
        ) : (
          <div className="space-y-2.5">
            <p className="text-[10px] leading-relaxed text-ink-400">
              Route the current wave through all {3} strategies and compare distance and labour time
              side by side.
            </p>
            <button
              type="button"
              onClick={runComparison}
              className="btn btn-primary w-full"
              disabled={comparing || orders.length === 0}
            >
              {comparing ? (
                <>
                  <span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-accent/30 border-t-accent" />
                  Routing {orders.length} orders…
                </>
              ) : (
                `Compare strategies (${orders.length} orders · ${totalLines} lines)`
              )}
            </button>
          </div>
        )}
      </Card>

      <Card title="Activity log" dense>
        {metrics.events.length === 0 ? (
          <EmptyState title="Nothing yet" body="Order releases, assignments and congestion appear here." />
        ) : (
          <ul className="space-y-1">
            {metrics.events.slice(0, 14).map((event) => (
              <li key={event.id} className="flex gap-2 text-[10px] leading-snug">
                <span className="shrink-0 font-mono tabular-nums text-ink-500">
                  {formatShort(event.at)}
                </span>
                <span
                  className={cx(
                    'shrink-0',
                    event.kind === 'congestion'
                      ? 'text-[var(--viz-warning)]'
                      : event.kind === 'completed'
                        ? 'text-[var(--viz-good)]'
                        : event.kind === 'assigned'
                          ? 'text-[var(--viz-series-1)]'
                          : 'text-ink-500',
                  )}
                >
                  ●
                </span>
                <span className="text-ink-300">{event.message}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

function ProgressRow({
  label,
  value,
  right,
  color,
}: {
  label: string
  value: number
  right: string
  color: string
}) {
  return (
    <div>
      <div className="mb-1 flex justify-between text-[10px]">
        <span className="text-ink-400">{label}</span>
        <span className="font-mono tabular-nums text-ink-200">{right}</span>
      </div>
      <Bar value={value} color={color} />
    </div>
  )
}

function MiniStat({
  label,
  value,
  tone = 'default',
  hint,
}: {
  label: string
  value: number
  tone?: 'default' | 'warn'
  hint?: string
}) {
  return (
    <div className="rounded-lg border border-ink-700/70 bg-ink-850/50 py-1.5" title={hint}>
      <div
        className={cx(
          'font-mono text-[15px] font-semibold tabular-nums',
          tone === 'warn' ? 'text-[var(--viz-warning)]' : 'text-ink-100',
        )}
      >
        {value}
      </div>
      <div className="text-[9px] uppercase tracking-wider text-ink-400">{label}</div>
      {hint && <div className="font-mono text-[8.5px] text-ink-500">{hint}</div>}
    </div>
  )
}

function formatShort(seconds: number): string {
  const s = Math.floor(seconds)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
