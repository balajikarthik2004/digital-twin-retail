import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { SimMetrics } from '../../simulation/types'
import { useAppStore } from '../../store/useAppStore'
import { clock, metres } from '../format'
import { chartPalette } from '../theme'
import { TooltipCard, TooltipRow } from './ComparisonCharts'

/**
 * Cumulative orders completed over simulation time.
 *
 * A single series, so the sequential hue is used and no legend box is needed —
 * the title names the series. Distance appears only in the tooltip: two
 * measures on different scales never share an axis.
 */
export function ThroughputChart({ metrics }: { metrics: SimMetrics }) {
  const p = chartPalette(useAppStore((s) => s.theme))
  const data = metrics.series

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <h4 className="text-[11px] font-semibold text-ink-200">Orders completed over shift</h4>
        <span className="font-mono text-[10px] tabular-nums text-ink-400">{clock(metrics.time)}</span>
      </div>
      <div className="h-[112px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 6, bottom: 0, left: -22 }}>
            <defs>
              <linearGradient id="throughputFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={p.sequential} stopOpacity={0.42} />
                <stop offset="100%" stopColor={p.sequential} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} strokeDasharray="2 4" />
            <XAxis
              dataKey="t"
              tickFormatter={(v: number) => `${Math.round(v / 60)}m`}
              axisLine={false}
              tickLine={false}
              // Wide enough that two ticks never round to the same minute label.
              minTickGap={44}
            />
            <YAxis allowDecimals={false} axisLine={false} tickLine={false} width={40} />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null
                const d = payload[0].payload as { t: number; completed: number; distance: number }
                return (
                  <TooltipCard title={`T+${clock(d.t)}`}>
                    <TooltipRow
                      label="Orders completed"
                      value={String(d.completed)}
                      swatch={p.sequential}
                    />
                    <TooltipRow label="Distance walked" value={metres(d.distance)} />
                  </TooltipCard>
                )
              }}
            />
            <Area
              type="monotone"
              dataKey="completed"
              stroke={p.sequential}
              strokeWidth={2}
              fill="url(#throughputFill)"
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: p.surface }}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
