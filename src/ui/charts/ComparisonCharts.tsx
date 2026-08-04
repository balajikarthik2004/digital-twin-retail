import {
  Bar,
  BarChart,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { StrategyComparison } from '../../simulation/types'
import { useAppStore } from '../../store/useAppStore'
import { hoursMin, metres } from '../format'
import { chartPalette } from '../theme'

const SHORT_NAME: Record<string, string> = {
  serpentine: 'S-Shape',
  'nearest-neighbour': 'Nearest N.',
  'tsp-2opt': 'TSP 2-opt',
}

function shortName(id: string, fallback: string) {
  return SHORT_NAME[id] ?? fallback
}

/**
 * Total walking distance per strategy.
 *
 * One measure across three categories, so colour carries no identity: a single
 * hue in two ordinal steps, with the winner in the lighter step plus a text
 * label. Values are labelled directly, so no legend is needed.
 */
export function DistanceComparisonChart({
  rows,
  activeStrategyId,
}: {
  rows: StrategyComparison[]
  activeStrategyId: string
}) {
  const p = chartPalette(useAppStore((s) => s.theme))
  const best = rows.reduce((a, b) => (b.totalDistance < a.totalDistance ? b : a))
  const worst = rows.reduce((a, b) => (b.totalDistance > a.totalDistance ? b : a))
  const data = rows.map((r) => ({
    name: shortName(r.strategyId, r.name),
    id: r.strategyId,
    distance: Math.round(r.totalDistance),
    perOrder: r.avgDistancePerOrder,
    isBest: r.strategyId === best.strategyId,
    isActive: r.strategyId === activeStrategyId,
  }))

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <h4 className="text-[11px] font-semibold text-ink-200">Total walking distance</h4>
        <span className="text-[10px] text-ink-400">lower is better</span>
      </div>
      <div className="h-[124px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 2, right: 62, bottom: 2, left: 0 }}>
            <XAxis type="number" hide domain={[0, worst.totalDistance * 1.12]} />
            <YAxis
              type="category"
              dataKey="name"
              width={72}
              axisLine={false}
              tickLine={false}
              tick={{ fill: p.textSecondary, fontSize: 10 }}
            />
            <Tooltip
              cursor={{ fill: 'rgb(var(--ink-750))' }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null
                const d = payload[0].payload as (typeof data)[number]
                return (
                  <TooltipCard title={d.name}>
                    <TooltipRow label="Total distance" value={metres(d.distance)} />
                    <TooltipRow label="Per order" value={metres(d.perOrder)} />
                    <TooltipRow
                      label="vs S-Shape"
                      value={
                        worst.totalDistance > 0
                          ? `${(((d.distance - worst.totalDistance) / worst.totalDistance) * 100).toFixed(1)}%`
                          : '—'
                      }
                    />
                  </TooltipCard>
                )
              }}
            />
            <Bar dataKey="distance" barSize={16} radius={[0, 4, 4, 0]} isAnimationActive={false}>
              {data.map((d) => (
                <Cell key={d.id} fill={d.isBest ? p.barBest : p.barBase} />
              ))}
              <LabelList
                dataKey="distance"
                position="right"
                formatter={(v: unknown) => metres(Number(v))}
                style={{ fill: p.textPrimary, fontSize: 10, fontWeight: 600 }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-ink-400">
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm" style={{ background: p.barBest }} />
          best: {shortName(best.strategyId, best.name)}
        </span>
        {best.strategyId !== worst.strategyId && worst.totalDistance > 0 && (
          <span className="text-[var(--viz-good)]">
            saves {metres(worst.totalDistance - best.totalDistance)} (
            {(((worst.totalDistance - best.totalDistance) / worst.totalDistance) * 100).toFixed(0)}%) vs{' '}
            {shortName(worst.strategyId, worst.name)}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * Estimated labour time split into walking / picking / pack-out.
 *
 * Three real series here, so the validated categorical slots 1-3 are used, with
 * a 2px surface gap between segments and a legend that is always present.
 */
export function TimeBreakdownChart({ rows }: { rows: StrategyComparison[] }) {
  const p = chartPalette(useAppStore((s) => s.theme))
  const SERIES = { walk: p.series[0], pick: p.series[1], pack: p.series[2] } as const
  const data = rows.map((r) => ({
    name: shortName(r.strategyId, r.name),
    id: r.strategyId,
    walk: Math.round(r.totalWalkTimeSec / 60),
    pick: Math.round(r.totalPickTimeSec / 60),
    pack: Math.round((r.estTotalTimeSec - r.totalWalkTimeSec - r.totalPickTimeSec) / 60),
    total: r.estTotalTimeSec,
  }))

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <h4 className="text-[11px] font-semibold text-ink-200">Estimated labour time</h4>
        <span className="text-[10px] text-ink-400">minutes, one picker</span>
      </div>
      <div className="h-[124px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 2, right: 56, bottom: 2, left: 0 }}>
            <XAxis type="number" hide />
            <YAxis
              type="category"
              dataKey="name"
              width={72}
              axisLine={false}
              tickLine={false}
              tick={{ fill: p.textSecondary, fontSize: 10 }}
            />
            <Tooltip
              cursor={{ fill: 'rgb(var(--ink-750))' }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null
                const d = payload[0].payload as (typeof data)[number]
                return (
                  <TooltipCard title={d.name}>
                    <TooltipRow label="Walking" value={`${d.walk} min`} swatch={SERIES.walk} />
                    <TooltipRow label="Picking" value={`${d.pick} min`} swatch={SERIES.pick} />
                    <TooltipRow label="Pack-out" value={`${d.pack} min`} swatch={SERIES.pack} />
                    <TooltipRow label="Total" value={hoursMin(d.total)} />
                  </TooltipCard>
                )
              }}
            />
            {(['walk', 'pick', 'pack'] as const).map((key, i, all) => (
              <Bar
                key={key}
                dataKey={key}
                stackId="t"
                barSize={16}
                fill={SERIES[key]}
                stroke={p.surface}
                strokeWidth={2}
                isAnimationActive={false}
                radius={i === all.length - 1 ? [0, 4, 4, 0] : undefined}
              >
                {i === all.length - 1 && (
                  <LabelList
                    dataKey="total"
                    position="right"
                    formatter={(v: unknown) => hoursMin(Number(v))}
                    style={{ fill: p.textPrimary, fontSize: 10, fontWeight: 600 }}
                  />
                )}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-ink-400">
        <LegendKey color={SERIES.walk} label="Walking" />
        <LegendKey color={SERIES.pick} label="Picking" />
        <LegendKey color={SERIES.pack} label="Pack-out" />
      </div>
    </div>
  )
}

/** Table view of the same numbers — identity never rests on colour alone. */
export function ComparisonTable({
  rows,
  activeStrategyId,
}: {
  rows: StrategyComparison[]
  activeStrategyId: string
}) {
  const best = rows.reduce((a, b) => (b.totalDistance < a.totalDistance ? b : a))
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[10.5px]">
        <thead>
          <tr className="text-left text-ink-400">
            <th className="pb-1 pr-2 font-medium">Strategy</th>
            <th className="pb-1 pr-2 text-right font-medium">Distance</th>
            <th className="pb-1 pr-2 text-right font-medium">Per order</th>
            <th className="pb-1 text-right font-medium">Orders/h</th>
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums">
          {rows.map((r) => (
            <tr key={r.strategyId} className="border-t border-ink-700/60">
              <td className="py-1.5 pr-2 font-sans">
                <span className="text-ink-100">{shortName(r.strategyId, r.name)}</span>
                {r.strategyId === activeStrategyId && (
                  <span className="ml-1 text-[9px] font-semibold uppercase tracking-wide text-accent-soft">
                    live
                  </span>
                )}
                {r.strategyId === best.strategyId && (
                  <span className="ml-1 text-[9px] font-semibold uppercase tracking-wide text-[var(--viz-good)]">
                    best
                  </span>
                )}
              </td>
              <td className="py-1.5 pr-2 text-right text-ink-100">{metres(r.totalDistance)}</td>
              <td className="py-1.5 pr-2 text-right text-ink-300">{metres(r.avgDistancePerOrder)}</td>
              <td className="py-1.5 text-right text-ink-300">{r.estOrdersPerPickerHour.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function LegendKey({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="h-2 w-2 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  )
}

export function TooltipCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-ink-600 bg-ink-800 px-2.5 py-2 shadow-float">
      <div className="mb-1 text-[10px] font-semibold text-ink-100">{title}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

export function TooltipRow({
  label,
  value,
  swatch,
}: {
  label: string
  value: string
  swatch?: string
}) {
  return (
    <div className="flex items-center justify-between gap-4 text-[10px]">
      <span className="flex items-center gap-1 text-ink-400">
        {swatch && <span className="h-1.5 w-1.5 rounded-sm" style={{ background: swatch }} />}
        {label}
      </span>
      <span className="font-mono tabular-nums text-ink-100">{value}</span>
    </div>
  )
}
