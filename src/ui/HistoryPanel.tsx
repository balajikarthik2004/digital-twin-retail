import { useMemo, useState } from 'react'
import type { Movement, MovementKind } from '../inbound/types'
import { useAppStore } from '../store/useAppStore'
import { Card, EmptyState, Segmented, StatTile, cx } from './components/primitives'
import { compact, metres, mmss } from './format'

/**
 * History — one log for everything that physically moved.
 *
 * Inbound putaways come from the store (they are an operator decision), shipped
 * orders come from the engine's completion log. Merging them is the only place
 * in the app where the two halves of the flow are read side by side.
 */

type Filter = MovementKind | 'all'

export function HistoryPanel() {
  const inboundLog = useAppStore((s) => s.inboundLog)
  const engine = useAppStore((s) => s.engine)
  const shipped = useAppStore((s) => s.metrics?.ordersCompleted ?? 0)

  const [filter, setFilter] = useState<Filter>('all')

  // `shipped` is the invalidation key: the engine mutates its completion log in
  // place, so its identity never changes on a tick.
  const movements = useMemo<Movement[]>(() => {
    const outbound: Movement[] = (engine?.completedOrders ?? []).map((c) => ({
      id: `out-${c.orderId}`,
      kind: 'outbound',
      at: c.finishedAt,
      ref: c.ref,
      detail: `${c.picks} lines · ${c.cartons} carton${c.cartons === 1 ? '' : 's'} · ${c.packStation}`,
      location: c.dock,
      qty: c.picks,
      distance: c.distance,
      onTime: c.onTime,
    }))
    return [...inboundLog, ...outbound].sort((a, b) => b.at - a.at)
  }, [inboundLog, engine, shipped])

  const visible = movements.filter((m) => filter === 'all' || m.kind === filter)

  const totals = useMemo(() => {
    let unitsIn = 0
    let linesOut = 0
    let distance = 0
    let late = 0
    for (const m of movements) {
      distance += m.distance
      if (m.kind === 'inbound') unitsIn += m.qty
      else {
        linesOut += m.qty
        if (m.onTime === false) late++
      }
    }
    return { unitsIn, linesOut, distance, late }
  }, [movements])

  const inboundCount = movements.filter((m) => m.kind === 'inbound').length
  const outboundCount = movements.length - inboundCount

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <Card title="Shift so far" dense>
        <div className="grid grid-cols-2 gap-2">
          <StatTile
            label="Units received"
            value={compact(totals.unitsIn)}
            sub={`${inboundCount} putaway${inboundCount === 1 ? '' : 's'}`}
            tone="accent"
          />
          <StatTile
            label="Orders shipped"
            value={String(outboundCount)}
            sub={totals.late > 0 ? `${totals.late} missed SLA` : 'all on time'}
            tone={totals.late > 0 ? 'warn' : 'good'}
          />
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
          <Fact label="Lines shipped" value={totals.linesOut.toLocaleString()} />
          <Fact label="Distance logged" value={metres(totals.distance)} />
        </div>
      </Card>

      <Card
        title="Movement log"
        dense
        action={
          movements.length > 0 ? (
            <button
              type="button"
              onClick={() => downloadCsv(visible)}
              className="btn !px-2 !py-1 !text-[10px]"
              title="Download the visible rows as CSV"
            >
              Export
            </button>
          ) : undefined
        }
      >
        <div className="mb-2">
          <Segmented
            value={filter}
            size="sm"
            options={[
              { value: 'all' as const, label: `All ${movements.length}` },
              { value: 'inbound' as const, label: `In ${inboundCount}` },
              { value: 'outbound' as const, label: `Out ${outboundCount}` },
            ]}
            onChange={setFilter}
          />
        </div>

        {visible.length === 0 ? (
          <EmptyState
            title="Nothing has moved yet"
            body="Confirm a putaway in Inbound, or run the simulation to start shipping orders."
          />
        ) : (
          <div className="space-y-1">
            {visible.slice(0, 120).map((m) => (
              <MovementRow key={m.id} movement={m} />
            ))}
            {visible.length > 120 && (
              <p className="pt-1 text-center text-[9.5px] text-ink-500">
                +{visible.length - 120} older rows — use Export for the full log.
              </p>
            )}
          </div>
        )}
      </Card>
    </div>
  )
}

function MovementRow({ movement }: { movement: Movement }) {
  const inbound = movement.kind === 'inbound'
  return (
    <div className="flex gap-2 rounded-md border border-ink-700/70 bg-ink-850/50 px-2 py-1.5">
      <span
        className={cx(
          'mt-0.5 shrink-0 font-mono text-[11px] leading-none',
          inbound ? 'text-[var(--viz-series-2)]' : 'text-[var(--viz-good)]',
        )}
        title={inbound ? 'Received' : 'Shipped'}
        aria-hidden
      >
        {inbound ? '↓' : '↑'}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10.5px] font-medium text-ink-100">{movement.ref}</span>
          <span className="flex-1" />
          <span className="shrink-0 font-mono text-[9.5px] tabular-nums text-ink-500">
            {mmss(movement.at)}
          </span>
        </div>
        <div className="truncate text-[9.5px] text-ink-400">{movement.detail}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[9px] text-ink-400">
          <span className="font-mono text-ink-300">{movement.location}</span>
          <span className="text-ink-600">·</span>
          <span>
            {movement.qty} {inbound ? 'units' : 'lines'}
          </span>
          <span className="text-ink-600">·</span>
          <span className="font-mono tabular-nums">{Math.round(movement.distance)} m</span>
          {movement.onTime === false && (
            <span className="text-[var(--viz-critical)]">· missed SLA</span>
          )}
        </div>
      </div>
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-ink-700/70 bg-ink-850/50 px-2 py-1.5">
      <div className="truncate text-ink-400">{label}</div>
      <div className="font-mono text-[13px] font-semibold tabular-nums text-ink-100">{value}</div>
    </div>
  )
}

const CSV_HEADER = 'direction,time,reference,detail,location,quantity,distance_m,on_time'

/** Quote a field for CSV — the detail column contains commas and middots. */
function cell(value: string | number | boolean | null): string {
  if (value === null) return ''
  const s = String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function downloadCsv(movements: Movement[]): void {
  const rows = movements.map((m) =>
    [m.kind, mmss(m.at), m.ref, m.detail, m.location, m.qty, Math.round(m.distance), m.onTime]
      .map(cell)
      .join(','),
  )
  const blob = new Blob([[CSV_HEADER, ...rows].join('\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'picktwin-movements.csv'
  a.click()
  URL.revokeObjectURL(url)
}
