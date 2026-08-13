import { useMemo, useState } from 'react'
import type { Movement, MovementKind } from '../inbound/types'
import { getStrategy } from '../pathfinding/strategies'
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
      strategy: getStrategy(c.strategyId).name,
      path: c.pickPath,
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
  const [open, setOpen] = useState(false)
  const path = movement.path ?? []
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

        {/*
          * The route, behind a disclosure. A tour of nine stops is far too much
          * to sit open in a log that is mostly scanned, but it is the one thing
          * here that cannot be reconstructed afterwards — the strategy chose
          * this order, and nothing else records what it chose.
          */}
        {path.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="mt-1 flex w-full items-center gap-1 text-left text-[9px] text-ink-400 transition-colors hover:text-accent-soft"
              aria-expanded={open}
            >
              <span className={cx('transition-transform', open && 'rotate-90')}>›</span>
              {open ? 'Hide' : 'Show'} route · {path.length} stops
              {movement.strategy && <span className="text-ink-500">· {movement.strategy}</span>}
            </button>

            {open && (
              <ol className="mt-1 space-y-0.5 border-l border-ink-700 pl-2">
                {path.map((step) => (
                  <li key={step.seq} className="flex items-baseline gap-1.5 text-[9px]">
                    <span className="w-4 shrink-0 text-right font-mono tabular-nums text-ink-500">
                      {step.seq}.
                    </span>
                    <span className="shrink-0 font-mono text-ink-200">{step.code}</span>
                    {step.reserve && (
                      <span
                        className="shrink-0 rounded bg-ink-700 px-1 text-[8px] font-semibold text-ink-200"
                        title="Reserve tier — reached by the staircase"
                      >
                        BULK
                      </span>
                    )}
                    <span className="truncate text-ink-400">{step.sku}</span>
                    <span className="ml-auto shrink-0 font-mono tabular-nums text-ink-500">
                      ×{step.qty}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
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

const CSV_HEADER =
  'direction,time,reference,detail,location,quantity,distance_m,on_time,' +
  'stops,pick_route,picked_products,bulk_stops'

/** Quote a field for CSV — the detail column contains commas and middots. */
function cell(value: string | number | boolean | null): string {
  if (value === null) return ''
  const s = String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * The walk, as two parallel columns: where the picker went, and what they
 * lifted at each stop.
 *
 * Split rather than combined because the two get used differently — the route
 * column is compared against a floor plan, the product column against a pick
 * list — and one merged string is awkward to read in either. Both carry the
 * same `n.` sequence numbers so a row in one lines up with a row in the other.
 *
 * The numbers are the position in the *tour*, not in the order, so a batched
 * order legitimately reads `2. ... 5. ... 6.` — the gaps are where the picker
 * was collecting the other order in the same batch, which is the thing you want
 * to see when asking why a route looked the way it did.
 *
 * Deliberately plain ASCII (`->`, `x2`) rather than the `→` and `×` this used
 * to emit. The BOM below makes those render correctly in Excel, but a CSV gets
 * opened by all sorts of things — a text editor set to a legacy code page, a
 * grep, an import script — and a separator that survives every one of them is
 * worth more here than a prettier glyph.
 */
const ARROW = ' -> '

function routeCell(path: Movement['path']): string {
  if (!path || path.length === 0) return ''
  return path.map((s) => `${s.seq}. ${s.code}${s.reserve ? ' (bulk)' : ''}`).join(ARROW)
}

function productsCell(path: Movement['path']): string {
  if (!path || path.length === 0) return ''
  return path.map((s) => `${s.seq}. ${s.sku} x${s.qty}`).join(ARROW)
}

function downloadCsv(movements: Movement[]): void {
  const rows = movements.map((m) =>
    [
      m.kind,
      mmss(m.at),
      m.ref,
      m.detail,
      m.location,
      m.qty,
      Math.round(m.distance),
      m.onTime,
      m.path?.length ?? '',
      routeCell(m.path),
      productsCell(m.path),
      m.path?.filter((s) => s.reserve).length ?? '',
    ]
      .map(cell)
      .join(','),
  )
  /*
   * Leading U+FEFF byte-order mark.
   *
   * Excel does not sniff UTF-8: without a BOM it opens a .csv in the machine's
   * legacy code page, so every multi-byte character arrives mangled — `·`
   * became `Â·`, `×` became `Ã—`. The BOM is three bytes that tell it the file
   * is UTF-8, and every other reader treats it as invisible whitespace. It
   * matters for the product names too, which can carry accents.
   */
  // Escaped rather than a literal BOM: an invisible character at the start of a
  // string literal is the kind of thing an editor or a reformat quietly eats.
  const csv = '\uFEFF' + [CSV_HEADER, ...rows].join('\r\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'picktwin-movements.csv'
  a.click()
  URL.revokeObjectURL(url)
}
