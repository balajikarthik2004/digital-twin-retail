import { useMemo, useRef, useState } from 'react'
import { SAMPLE_ORDERS_DOC } from '../data'
import { channelHex } from '../scene/theme'
import type { Order } from '../simulation/types'
import { useAppStore } from '../store/useAppStore'
import { isReserveLevel } from '../warehouse/rackGeometry'
import type { WarehouseModel } from '../warehouse/types'
import { Bar, Card, EmptyState, Segmented, StatTile, cx } from './components/primitives'
import { ChevronRightIcon } from './components/icons'
import { mmss, pct } from './format'
import { chartPalette } from './theme'

/**
 * Outbound section — the wave, and where every order in it currently is.
 *
 * The counters in the right-hand dashboard say how many orders are in each
 * stage; this says *which* ones, so a specific reference can be chased.
 */

type OrderStage = 'shipped' | 'picking' | 'released' | 'scheduled'

const STAGE_LABEL: Record<OrderStage, string> = {
  shipped: 'Shipped',
  picking: 'On a tour',
  released: 'Queued',
  scheduled: 'Not released',
}

const STAGE_TONE: Record<OrderStage, string> = {
  shipped: 'text-[var(--viz-good)]',
  picking: 'text-[var(--viz-series-1)]',
  released: 'text-ink-300',
  scheduled: 'text-ink-500',
}

type StageFilter = OrderStage | 'all'

export function OutboundPanel() {
  const orders = useAppStore((s) => s.orders)
  const engine = useAppStore((s) => s.engine)
  const metrics = useAppStore((s) => s.metrics)
  const model = useAppStore((s) => s.model)
  const theme = useAppStore((s) => s.theme)
  const palette = chartPalette(theme)
  const CHANNEL_HEX = channelHex(theme)

  const regenerateOrders = useAppStore((s) => s.regenerateOrders)
  const loadSampleOrders = useAppStore((s) => s.loadSampleOrders)
  const clearOrders = useAppStore((s) => s.clearOrders)

  const [filter, setFilter] = useState<StageFilter>('all')

  const now = metrics?.time ?? 0
  const completedCount = metrics?.ordersCompleted ?? 0

  // Stage per order, rebuilt only when the pipeline actually moves. Refs are the
  // shared key: the engine reports completions and tours by ref, not by id.
  const stages = useMemo(() => {
    const shipped = new Set((engine?.completedOrders ?? []).map((c) => c.ref))
    const onTour = new Set((metrics?.agents ?? []).flatMap((a) => a.orderRefs))
    const map = new Map<string, OrderStage>()
    for (const order of orders) {
      map.set(
        order.id,
        shipped.has(order.ref)
          ? 'shipped'
          : onTour.has(order.ref)
            ? 'picking'
            : order.releasedAt <= now
              ? 'released'
              : 'scheduled',
      )
    }
    return map
    // `completedCount` and the in-progress count stand in for the engine's
    // internal mutation — neither `engine` nor `orders` changes identity on a tick.
  }, [orders, engine, metrics?.agents, now, completedCount])

  const counts = useMemo(() => {
    const c: Record<OrderStage, number> = { shipped: 0, picking: 0, released: 0, scheduled: 0 }
    for (const stage of stages.values()) c[stage]++
    return c
  }, [stages])

  const visible = orders.filter((o) => filter === 'all' || stages.get(o.id) === filter)
  const totalLines = orders.reduce((s, o) => s + o.lines.length, 0)
  const totalUnits = orders.reduce((s, o) => s + o.lines.reduce((t, l) => t + l.qty, 0), 0)

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <Card
        title="Wave"
        dense
        action={
          <span className="chip">
            {orders.length} orders · {totalLines} lines
          </span>
        }
      >
        <div className="grid grid-cols-2 gap-2">
          <StatTile
            label="Shipped"
            value={String(counts.shipped)}
            sub={`of ${orders.length} in the wave`}
            tone="accent"
          />
          <StatTile label="Units to pick" value={totalUnits.toLocaleString()} sub={`${totalLines} lines`} />
        </div>

        {orders.length > 0 && (
          <div className="mt-2.5">
            <div className="mb-1 flex justify-between text-[10px]">
              <span className="text-ink-400">Wave progress</span>
              <span className="font-mono tabular-nums text-ink-200">
                {pct(counts.shipped / orders.length)}
              </span>
            </div>
            <Bar value={counts.shipped / orders.length} color={palette.good} />
          </div>
        )}

        <div className="mt-2.5 flex gap-2">
          <button type="button" onClick={regenerateOrders} className="btn btn-primary flex-1">
            Generate new wave
          </button>
          <button type="button" onClick={() => void loadSampleOrders()} className="btn">
            Sample
          </button>
        </div>
        <button
          type="button"
          onClick={clearOrders}
          className="btn mt-2 w-full"
          disabled={orders.length === 0}
        >
          Clear wave queue
        </button>
      </Card>

      <BulkRetrievalCard model={model} orders={orders} />

      <Card
        title="Order queue"
        dense
        action={<span className="chip">{visible.length} shown</span>}
      >
        <div className="mb-2">
          <Segmented
            value={filter}
            size="sm"
            options={[
              { value: 'all' as const, label: `All ${orders.length}` },
              { value: 'released' as const, label: `Queued ${counts.released}` },
              { value: 'picking' as const, label: `Tour ${counts.picking}` },
              { value: 'shipped' as const, label: `Out ${counts.shipped}` },
            ]}
            onChange={setFilter}
          />
        </div>

        {visible.length === 0 ? (
          <EmptyState
            title={orders.length === 0 ? 'No orders queued' : 'Nothing in this stage'}
            body={
              orders.length === 0
                ? 'Generate a wave, load the sample, or import a WMS export below.'
                : undefined
            }
          />
        ) : (
          <div className="space-y-1">
            {visible.slice(0, 60).map((order) => (
              <OrderRow
                key={order.id}
                order={order}
                model={model}
                stage={stages.get(order.id) ?? 'scheduled'}
                channelColor={CHANNEL_HEX[order.channel]}
                now={now}
              />
            ))}
            {visible.length > 60 && (
              <p className="pt-1 text-center text-[9.5px] text-ink-500">
                +{visible.length - 60} more — narrow the filter to see them.
              </p>
            )}
          </div>
        )}
      </Card>

      <ImportCard />
    </div>
  )
}

function OrderRow({
  order,
  model,
  stage,
  channelColor,
  now,
}: {
  order: Order
  model: WarehouseModel | null
  stage: OrderStage
  channelColor: string
  now: number
}) {
  const [open, setOpen] = useState(false)
  const units = order.lines.reduce((s, l) => s + l.qty, 0)
  // Only meaningful while the order is still in the building.
  const late = stage !== 'shipped' && now > order.dueAt

  const value = order.lines.reduce((sum, l) => {
    const price = model?.binsById.get(l.binId)?.sku.price
    return sum + (price ?? 0) * l.qty
  }, 0)
  const hasPricing = order.lines.some((l) => model?.binsById.get(l.binId)?.sku.price != null)

  return (
    <div className="rounded-md border border-ink-700/70 bg-ink-850/50 px-2 py-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: channelColor }} />
          <span className="font-mono text-[10.5px] font-medium text-ink-100">{order.ref}</span>
          {order.priority === 'express' && (
            <span className="chip !px-1 !py-0 !text-[8px] !text-[var(--viz-warning)]">express</span>
          )}
          <span className="flex-1" />
          <span className={cx('text-[9.5px] font-medium', STAGE_TONE[stage])}>
            {STAGE_LABEL[stage]}
          </span>
          <span
            aria-hidden
            className={cx(
              'shrink-0 text-[9px] text-ink-500 transition-transform duration-150',
              open && 'rotate-90',
            )}
          >
            ›
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[9px] text-ink-400">
          <span>{order.channel}</span>
          <span className="text-ink-600">·</span>
          <span>
            {order.lines.length} lines · {units} ea
          </span>
          {hasPricing && (
            <>
              <span className="text-ink-600">·</span>
              <span className="font-mono tabular-nums text-ink-300">${value.toFixed(2)}</span>
            </>
          )}
          <span className="flex-1" />
          <span className={cx('font-mono tabular-nums', late && 'text-[var(--viz-critical)]')}>
            due {mmss(order.dueAt)}
          </span>
        </div>
      </button>

      {open && (
        <div className="mt-1.5 space-y-1 border-t border-ink-700/60 pt-1.5">
          {order.lines.map((line, i) => {
            const bin = model?.binsById.get(line.binId)
            return (
              <div
                key={`${line.binId}-${i}`}
                className="rounded-md border border-ink-700/60 bg-ink-800/50 px-2 py-1.5"
              >
                <div className="truncate text-[10px] text-ink-100">{bin?.sku.name ?? line.sku}</div>
                <div className="mt-1 grid grid-cols-[1.3fr_1.2fr_0.6fr_0.8fr] gap-2 text-[9px]">
                  <div className="min-w-0">
                    <div className="text-ink-500">ID</div>
                    <div className="truncate font-mono text-ink-300">{bin?.sku.id ?? line.sku}</div>
                  </div>
                  <div className="min-w-0">
                    <div className="text-ink-500">Category</div>
                    <div className="truncate text-ink-300">{bin?.sku.category ?? '—'}</div>
                  </div>
                  <div className="min-w-0">
                    <div className="text-ink-500">Qty</div>
                    <div className="truncate font-mono tabular-nums text-ink-300">{line.qty} ea</div>
                  </div>
                  <div className="min-w-0 text-right">
                    <div className="text-ink-500">Price</div>
                    <div className="truncate font-mono tabular-nums text-accent-soft">
                      {bin ? `$${bin.sku.price.toFixed(2)}` : '—'}
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Bring a real wave in from a WMS export. */
function ImportCard() {
  const importOrdersJson = useAppStore((s) => s.importOrdersJson)
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const onFile = (file: File | undefined) => {
    if (!file) return
    void file.text().then((contents) => {
      setText(contents)
      importOrdersJson(contents)
    })
  }

  return (
    <Card
      title="Import real data"
      dense
      action={
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="btn btn-icon"
          aria-expanded={open}
          aria-label={open ? 'Collapse' : 'Expand'}
        >
          <ChevronRightIcon className={cx('transition-transform duration-150', open && 'rotate-90')} />
        </button>
      }
    >
      {open ? (
        <div className="space-y-2">
          <p className="text-[10px] leading-relaxed text-ink-400">
            Paste a JSON array of orders, or upload a file. Locations accept an operator code (
            <span className="font-mono text-ink-300">A03-R14-2B</span>), a bin id or a SKU id.
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            placeholder={'[{ "ref": "SO-1001", "lines": [{ "location": "A03-R14-2B", "qty": 2 }] }]'}
            className="h-28 w-full resize-y rounded-lg border border-ink-700 bg-ink-850 p-2 font-mono text-[10px] leading-relaxed text-ink-100 outline-none transition-colors placeholder:text-ink-500 focus:border-accent"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => importOrdersJson(text)}
              className="btn btn-primary flex-1"
              disabled={text.trim().length === 0}
            >
              Load orders
            </button>
            <button type="button" onClick={() => fileRef.current?.click()} className="btn">
              Upload .json
            </button>
          </div>
          <button
            type="button"
            onClick={() => setText(JSON.stringify(SAMPLE_ORDERS_DOC, null, 2))}
            className="btn w-full"
          >
            Fill with sample format
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => onFile(e.target.files?.[0])}
          />
        </div>
      ) : (
        <p className="text-[10px] leading-relaxed text-ink-400">
          Drop in a WMS wave export to route real pick lists through the same engine.
        </p>
      )}
    </Card>
  )
}

/**
 * Bulk retrieval — the shift's vertical dimension.
 *
 * Roughly a third of every wave is slotted in the reserve tier upstairs, and
 * the only way to it is one of the two staircases. That is by far the most
 * expensive thing a picker does here, and none of the flat metrics say so: a
 * bulk line and a pick-face line both read as "1 line" in the wave summary,
 * while one of them cost a climb and a walk down the mezzanine.
 *
 * So this card answers three questions in order — how much of the work is up
 * there, what it cost to get to it, and how well each trip was amortised.
 * Everything is derived from counters the engine already keeps per picker; the
 * planned side reads the wave itself, so the card says something useful before
 * the simulation has ever been run.
 */
function BulkRetrievalCard({ model, orders }: { model: WarehouseModel | null; orders: Order[] }) {
  const metrics = useAppStore((s) => s.metrics)
  const theme = useAppStore((s) => s.theme)
  const palette = chartPalette(theme)

  // What the wave *asks* for, straight off the order lines — available with the
  // clock at zero, which is when someone is most likely to be reading this.
  const planned = useMemo(() => {
    if (!model) return { bulk: 0, total: 0 }
    let bulk = 0
    let total = 0
    for (const order of orders) {
      for (const line of order.lines) {
        total++
        const bin = model.binsById.get(line.binId)
        if (bin && isReserveLevel(model.config, bin.level)) bulk++
      }
    }
    return { bulk, total }
  }, [model, orders])

  if (planned.total === 0) {
    return (
      <Card title="Bulk retrieval" dense>
        <EmptyState
          title="No wave queued"
          body="Generate a wave to see how much of it is slotted in the reserve tier upstairs."
        />
      </Card>
    )
  }

  const plannedShare = planned.bulk / planned.total
  const picked = metrics?.bulkPicks ?? 0
  const climbs = metrics?.stairClimbs ?? 0
  const started = (metrics?.totalPicks ?? 0) > 0

  return (
    <Card
      title="Bulk retrieval"
      dense
      action={<span className="chip">{pct(plannedShare)} of lines</span>}
    >
      {/* Where the wave's work physically sits. Two segments of one bar rather
          than two numbers, because the point is the proportion between them. */}
      <div className="mb-1 flex items-baseline justify-between text-[10px]">
        <span className="text-ink-400">Reserve tier vs pick face</span>
        <span className="font-mono tabular-nums text-ink-200">
          {planned.bulk.toLocaleString()} / {planned.total.toLocaleString()} lines
        </span>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-ink-750">
        <div
          className="h-full"
          style={{ width: `${plannedShare * 100}%`, background: palette.series[1] }}
          title={`${planned.bulk} lines upstairs, reached by staircase`}
        />
        <div
          className="h-full"
          style={{ width: `${(1 - plannedShare) * 100}%`, background: palette.series[0] }}
          title={`${planned.total - planned.bulk} lines on the pick face`}
        />
      </div>
      <div className="mt-1.5 flex justify-between text-[9.5px] text-ink-400">
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: palette.series[1] }} />
          Upstairs
        </span>
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: palette.series[0] }} />
          Pick face
        </span>
      </div>

      <div className="divider" />

      <div className="grid grid-cols-2 gap-2">
        <StatTile
          label="Lines picked"
          value={picked.toLocaleString()}
          sub={started ? `of ${planned.bulk.toLocaleString()} upstairs` : 'not started'}
          tone="accent"
        />
        <StatTile
          label="Staircase climbs"
          value={climbs.toLocaleString()}
          sub={started ? 'trips onto the mezzanine' : 'not started'}
        />
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2">
        <StatTile
          label="Lines per climb"
          value={climbs > 0 ? (metrics?.picksPerClimb ?? 0).toFixed(1) : '—'}
          sub="picked per trip up"
        />
        <StatTile
          label="Time upstairs"
          value={started ? pct(metrics?.elevatedShare ?? 0) : '—'}
          sub="of all picker time"
        />
      </div>

      {/*
        * One plain sentence, because "1.8 lines per climb" only means something
        * next to the alternative. A tour that collects several bulk lines on one
        * trip has amortised the staircase; one line per climb means the picker
        * walked the whole flight for a single carton, which is the case worth
        * noticing and the argument for batching bulk lines together.
        */}
      {climbs > 0 && (
        <p className="mt-2 text-[10px] leading-relaxed text-ink-400">
          {(metrics?.picksPerClimb ?? 0) >= 2
            ? `Each climb is collecting ${(metrics?.picksPerClimb ?? 0).toFixed(1)} lines, so the trips are being shared across several picks rather than made one at a time.`
            : 'Close to one line per climb — pickers are walking a full flight per carton. Batching bulk lines onto the same tour is what would pay here.'}
        </p>
      )}
    </Card>
  )
}
