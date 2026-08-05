import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { summariseFreeSpace, type SpaceBucket } from '../inbound/freeSpace'
import { listAvailable } from '../inbound/putaway'
import {
  outstandingUnits,
  receiptStatus,
  variance,
  type PutawayCandidate,
  type Receipt,
  type ReceiptLine,
  type ReceiptStatus,
} from '../inbound/types'
import { VELOCITY_LABEL, velocityHex } from '../scene/theme'
import { useAppStore } from '../store/useAppStore'
import type { VelocityTier } from '../warehouse/types'
import { Bar, Card, EmptyState, Segmented, StatTile, cx } from './components/primitives'
import { compact, metres, mmss, pct, shortDuration } from './format'
import { chartPalette } from './theme'

/**
 * Inbound section — the receiving process, in the order it actually happens on a
 * goods-in bay:
 *
 *   1. Deliveries    what is on the advice notes; pick the line that turned up.
 *   2. Receive       count it in. Until this, the quantity is a supplier claim.
 *   3. Location      where it goes — recommended, or chosen from the free space.
 *   4. Route         the walk to get there.
 *   5. Place         an operator carries it there in the simulation.
 *
 * The step is derived from store state rather than held separately, so the panel
 * can never disagree with what the 3D scene is drawing.
 */
export function InboundPanel() {
  const plan = useAppStore((s) => s.putawayPlan)
  const confirmed = useAppStore((s) => s.locationConfirmed)
  const run = useAppStore((s) => s.placementRun)
  const placement = useAppStore((s) => s.lastPlacement)
  const activeLine = useAppStore((s) => s.activeLine)
  const receipts = useAppStore((s) => s.receipts)

  const line = activeLine
    ? receipts.find((r) => r.id === activeLine.receiptId)?.lines.find((l) => l.id === activeLine.lineId)
    : undefined

  const step: 1 | 2 | 3 | 4 | 5 =
    run || placement
      ? 5
      : plan && confirmed
        ? 4
        : plan
          ? 3
          : line && line.status !== 'expected'
            ? // Counted in, but nothing legal to put it into.
              3
            : line
              ? 2
              : 1

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <Stepper step={step} />

      {step === 1 && <DeliveriesStep />}
      {step === 2 && <ReceiveStep />}
      {/* Two very different reasons a received line has no plan: nothing turned
          up, or nowhere legal to put what did. */}
      {step === 3 &&
        (plan ? (
          <LocationStep />
        ) : line && line.receivedQty === 0 ? (
          <NothingReceivedCard />
        ) : (
          <NoSpaceCard />
        ))}
      {step === 4 && <RouteStep />}
      {step === 5 && <PlaceStep />}

      <FreeSpaceSummaryCard />
      <StorageFooter />
    </div>
  )
}

// ── stepper ───────────────────────────────────────────────────────────────────

const STEPS = ['List', 'Receive', 'Location', 'Route', 'Place'] as const

function Stepper({ step }: { step: number }) {
  return (
    <ol className="flex items-center gap-1" aria-label="Inbound progress">
      {STEPS.map((label, i) => {
        const n = i + 1
        const done = n < step
        const active = n === step
        return (
          <li key={label} className="flex flex-1 items-center gap-1">
            <span
              className={cx(
                'grid h-5 w-5 shrink-0 place-items-center rounded-full font-mono text-[10px] font-bold',
                active
                  ? 'bg-accent text-ink-900'
                  : done
                    ? 'bg-[var(--viz-good)] text-white'
                    : 'bg-ink-700 text-ink-400',
              )}
              aria-current={active ? 'step' : undefined}
            >
              {done ? '✓' : n}
            </span>
            <span
              className={cx(
                'truncate text-[9.5px] font-medium',
                active ? 'text-accent-soft' : done ? 'text-ink-300' : 'text-ink-500',
              )}
            >
              {label}
            </span>
            {i < STEPS.length - 1 && <span className="h-px flex-1 bg-ink-700" />}
          </li>
        )
      })}
    </ol>
  )
}

// ── step 1: the inbound list ──────────────────────────────────────────────────

const VELOCITIES: VelocityTier[] = ['fast', 'medium', 'slow']

const INPUT =
  'w-full rounded-lg border border-ink-700 bg-ink-850 px-2 py-1.5 text-[11px] text-ink-100 outline-none transition-colors placeholder:text-ink-500 focus:border-accent'

const RECEIPT_STATUS_LABEL: Record<ReceiptStatus, string> = {
  expected: 'expected',
  receiving: 'part received',
  received: 'received',
  stored: 'put away',
}

const RECEIPT_STATUS_TONE: Record<ReceiptStatus, string> = {
  expected: 'text-ink-400',
  receiving: 'text-[var(--viz-warning)]',
  received: 'text-[var(--viz-series-1)]',
  stored: 'text-[var(--viz-good)]',
}

type ListFilter = 'open' | 'all'

/**
 * Where receiving starts: the advice notes.
 *
 * A delivery is worked line by line off this list — that is the actual sequence
 * on a goods-in bay, and it is why the manual form is tucked away as the
 * exception rather than being the way in.
 */
function DeliveriesStep() {
  const receipts = useAppStore((s) => s.receipts)
  const selectLine = useAppStore((s) => s.selectLine)
  const regenerateReceipts = useAppStore((s) => s.regenerateReceipts)
  const clearReceipts = useAppStore((s) => s.clearReceipts)
  const [filter, setFilter] = useState<ListFilter>('open')

  const counts = useMemo(() => {
    let expected = 0
    let received = 0
    let stored = 0
    let expectedUnits = 0
    for (const r of receipts) {
      for (const l of r.lines) {
        if (l.status === 'expected') {
          expected++
          expectedUnits += l.expectedQty
        } else if (l.status === 'received') received++
        else stored++
      }
    }
    return { expected, received, stored, expectedUnits, open: expected + received }
  }, [receipts])

  const visible =
    filter === 'all'
      ? receipts
      : receipts.filter((r) => r.lines.some((l) => l.status !== 'stored'))

  return (
    <>
      <Card
        title="Inbound deliveries"
        dense
        action={<span className="chip">{counts.open} lines open</span>}
      >
        <div className="grid grid-cols-3 gap-2 text-center">
          <MiniCount label="To count" value={counts.expected} tone="default" />
          <MiniCount label="To put away" value={counts.received} tone="accent" />
          <MiniCount label="Done" value={counts.stored} tone="good" />
        </div>
        {counts.expectedUnits > 0 && (
          <p className="mt-2 text-[9.5px] leading-snug text-ink-400">
            {compact(counts.expectedUnits)} units advised and not yet counted in. Pick a line to
            receive it.
          </p>
        )}

        <div className="mt-2 flex items-center justify-between gap-2">
          <Segmented
            value={filter}
            size="sm"
            options={[
              { value: 'open' as const, label: 'Open' },
              { value: 'all' as const, label: `All ${receipts.length}` },
            ]}
            onChange={setFilter}
          />
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={regenerateReceipts}
              className="btn !px-2 !py-1 !text-[10px]"
            >
              New schedule
            </button>
            <button
              type="button"
              onClick={clearReceipts}
              className="btn !px-2 !py-1 !text-[10px]"
              disabled={receipts.length === 0}
            >
              Clear
            </button>
          </div>
        </div>

        <div className="mt-2 space-y-2">
          {visible.length === 0 ? (
            <EmptyState
              title={receipts.length === 0 ? 'Nothing booked in' : 'Everything is put away'}
              body={
                receipts.length === 0
                  ? 'Generate a schedule of inbound trailers, or book an unplanned delivery in below.'
                  : 'Switch to All to review what has already been received.'
              }
            />
          ) : (
            visible.map((receipt) => (
              <ReceiptCard
                key={receipt.id}
                receipt={receipt}
                onSelect={(lineId) => selectLine(receipt.id, lineId)}
              />
            ))
          )}
        </div>
      </Card>

      <UnplannedCard />
    </>
  )
}

function MiniCount({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'default' | 'accent' | 'good'
}) {
  return (
    <div className="rounded-lg border border-ink-700/70 bg-ink-850/50 py-1.5">
      <div
        className={cx(
          'font-mono text-[15px] font-semibold tabular-nums',
          tone === 'accent'
            ? 'text-accent-soft'
            : tone === 'good'
              ? 'text-[var(--viz-good)]'
              : 'text-ink-100',
        )}
      >
        {value}
      </div>
      <div className="text-[9px] uppercase tracking-wider text-ink-400">{label}</div>
    </div>
  )
}

function ReceiptCard({
  receipt,
  onSelect,
}: {
  receipt: Receipt
  onSelect: (lineId: string) => void
}) {
  const status = receiptStatus(receipt)
  const activeLine = useAppStore((s) => s.activeLine)

  return (
    <div className="rounded-lg border border-ink-700/70 bg-ink-850/40 p-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] font-semibold text-ink-100">{receipt.ref}</span>
        <span className={cx('text-[9px] font-medium uppercase tracking-wider', RECEIPT_STATUS_TONE[status])}>
          {RECEIPT_STATUS_LABEL[status]}
        </span>
        <span className="flex-1" />
        <span className="font-mono text-[9.5px] tabular-nums text-ink-500">
          {mmss(receipt.arrivedAt)}
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-[9.5px] text-ink-400">
        <span className="truncate">{receipt.supplier}</span>
        <span className="shrink-0 text-ink-600">·</span>
        <span className="shrink-0 font-mono">{receipt.po}</span>
      </div>

      <div className="mt-1.5 space-y-1">
        {receipt.lines.map((line) => (
          <LineRow
            key={line.id}
            line={line}
            active={activeLine?.lineId === line.id}
            onClick={() => onSelect(line.id)}
          />
        ))}
      </div>
    </div>
  )
}

function LineRow({
  line,
  active,
  onClick,
}: {
  line: ReceiptLine
  active: boolean
  onClick: () => void
}) {
  const stored = line.status === 'stored'
  const off = variance(line)
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'w-full rounded-md border px-2 py-1.5 text-left transition-all duration-150',
        active
          ? 'option-active'
          : 'border-ink-700/70 bg-ink-800/60 hover:border-ink-600 hover:bg-ink-750',
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cx('flex-1 truncate text-[10.5px]', stored ? 'text-ink-400' : 'text-ink-100')}
        >
          {line.name}
        </span>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-300">
          {line.status === 'expected' ? line.expectedQty : line.receivedQty} ea
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-[9px] text-ink-400">
        {stored ? (
          <span className="text-[var(--viz-good)]">✓ put away at {line.storedCode}</span>
        ) : line.status === 'expected' ? (
          <span>
            advised · {line.skuId ? 'top-up' : 'new line'} · tap to count in
          </span>
        ) : line.storedQty > 0 ? (
          <span className="text-[var(--viz-warning)]">
            {line.storedQty} at {line.storedCode} · {outstandingUnits(line)} left to put away
          </span>
        ) : (
          <span className="text-[var(--viz-series-1)]">received · needs a location</span>
        )}
        {off !== 0 && (
          <span className="shrink-0 text-[var(--viz-warning)]">
            {off > 0 ? `+${off} over` : `${off} short`}
          </span>
        )}
      </div>
    </button>
  )
}

/** Stock at the door with no advice note against it — the exception path. */
function UnplannedCard() {
  const model = useAppStore((s) => s.model)
  const bookInProduct = useAppStore((s) => s.bookInProduct)
  const VELOCITY_HEX = velocityHex(useAppStore((s) => s.theme))

  const [open, setOpen] = useState(false)
  const [lookup, setLookup] = useState('')
  const [name, setName] = useState('')
  const [qty, setQty] = useState('120')
  const [unitVolume, setUnitVolume] = useState('2.5')
  const [velocity, setVelocity] = useState<VelocityTier>('medium')

  const matched = useMemo(() => {
    if (!model) return null
    const key = lookup.trim().toUpperCase()
    if (key.length < 3) return null
    return (
      model.bins.find((b) => b.code.toUpperCase() === key) ??
      model.bins.find((b) => b.sku.id.toUpperCase() === key) ??
      model.bins.find((b) => b.sku.name.toUpperCase() === key) ??
      null
    )
  }, [model, lookup])

  const quantity = Math.max(0, Math.round(Number(qty) || 0))
  const volume = Math.max(0, Number(unitVolume) || 0)
  const productName = matched ? matched.sku.name : name.trim()
  const valid = productName.length > 0 && quantity > 0 && (matched !== null || volume > 0)

  const submit = () => {
    if (!valid) return
    bookInProduct({
      name: productName,
      skuId: matched?.sku.id ?? null,
      category: matched?.sku.category ?? 'Uncategorised',
      velocity: matched?.sku.velocity ?? velocity,
      qty: quantity,
      unitVolume: matched?.sku.unitVolume ?? volume,
    })
    setLookup('')
    setName('')
    setOpen(false)
  }

  return (
    <Card
      title="Unplanned delivery"
      dense
      action={
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="btn btn-icon"
          aria-expanded={open}
          aria-label={open ? 'Collapse' : 'Expand'}
        >
          {open ? '−' : '+'}
        </button>
      }
    >
      {!open ? (
        <p className="text-[10px] leading-relaxed text-ink-400">
          Stock at the door with no advice note? Book it in here — you are holding it, so it counts
          as received straight away.
        </p>
      ) : (
        <div className="space-y-2">
          <Field
            label="Already stocked? Enter its location code or SKU id"
            hint="Leave blank for a line the facility has never held."
          >
            <input
              value={lookup}
              onChange={(e) => setLookup(e.target.value)}
              spellCheck={false}
              placeholder="A03-R14-2B  ·  SKU-000412"
              className={INPUT}
            />
          </Field>

          {matched ? (
            <div className="rounded-md border border-accent/40 bg-accent/5 px-2 py-1.5">
              <div className="truncate text-[11px] font-medium text-ink-100">{matched.sku.name}</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[9.5px] text-ink-400">
                <span
                  className="h-2 w-2 rounded-sm"
                  style={{ background: VELOCITY_HEX[matched.sku.velocity] }}
                />
                <span>{VELOCITY_LABEL[matched.sku.velocity]}</span>
                <span className="text-ink-600">·</span>
                <span className="font-mono">{matched.code}</span>
                <span className="text-ink-600">·</span>
                <span>
                  {matched.sku.stock}/{matched.capacity} on hand
                </span>
              </div>
            </div>
          ) : (
            <>
              <Field label="Product name">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submit()}
                  placeholder="Nordvale Cold Brew"
                  className={INPUT}
                />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Litres per unit">
                  <input
                    value={unitVolume}
                    onChange={(e) => setUnitVolume(e.target.value)}
                    inputMode="decimal"
                    className={INPUT}
                  />
                </Field>
                <Field label="Velocity class">
                  <select
                    value={velocity}
                    onChange={(e) => setVelocity(e.target.value as VelocityTier)}
                    className={INPUT}
                  >
                    {VELOCITIES.map((v) => (
                      <option key={v} value={v}>
                        {VELOCITY_LABEL[v]}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            </>
          )}

          <Field label="Units received">
            <input
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              inputMode="numeric"
              className={INPUT}
            />
          </Field>

          <button type="button" onClick={submit} disabled={!valid} className="btn btn-primary w-full">
            Book in & find space →
          </button>
        </div>
      )}
    </Card>
  )
}

// ── step 2: count it in ───────────────────────────────────────────────────────

/**
 * The goods receipt.
 *
 * Advised quantity is the supplier's claim; this is where it becomes the
 * facility's number. Short and over deliveries are the norm, not an error, so
 * the variance is shown plainly and the count is accepted either way.
 */
function ReceiveStep() {
  const activeLine = useAppStore((s) => s.activeLine)!
  const receipts = useAppStore((s) => s.receipts)
  const receiveLine = useAppStore((s) => s.receiveLine)
  const cancelPutaway = useAppStore((s) => s.cancelPutaway)
  const VELOCITY_HEX = velocityHex(useAppStore((s) => s.theme))

  const receipt = receipts.find((r) => r.id === activeLine.receiptId)
  const line = receipt?.lines.find((l) => l.id === activeLine.lineId)

  const [counted, setCounted] = useState('')
  // Pre-fill with the advised figure: matching it is the common case, and
  // re-typing a number you can already see is busywork.
  useEffect(() => {
    if (line) setCounted(String(line.expectedQty))
  }, [line?.id, line?.expectedQty])

  if (!receipt || !line) return null

  const qty = Math.max(0, Math.round(Number(counted) || 0))
  const off = qty - line.expectedQty
  const valid = counted.trim() !== '' && Number.isFinite(Number(counted)) && qty >= 0

  return (
    <Card title="Count it in" dense action={<span className="chip">{receipt.ref}</span>}>
      <div className="rounded-lg border border-ink-700 bg-ink-850/60 p-2.5">
        <div className="truncate text-[11.5px] font-medium text-ink-100">{line.name}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[9.5px] text-ink-400">
          <span className="h-2 w-2 rounded-sm" style={{ background: VELOCITY_HEX[line.velocity] }} />
          <span>{VELOCITY_LABEL[line.velocity]}</span>
          <span className="text-ink-600">·</span>
          <span>{line.category}</span>
          {line.skuId && (
            <>
              <span className="text-ink-600">·</span>
              <span className="font-mono">{line.skuId}</span>
            </>
          )}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
          <Metric label="Advised" value={`${line.expectedQty} ea`} />
          <Metric label="Supplier" value={receipt.supplier} />
        </div>
      </div>

      <div className="mt-2.5">
        <Field label="Units actually received">
          <input
            value={counted}
            onChange={(e) => setCounted(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && valid && receiveLine(receipt.id, line.id, qty)}
            inputMode="numeric"
            autoFocus
            className={INPUT}
          />
        </Field>

        <div
          className={cx(
            'mt-1.5 rounded-md border px-2 py-1.5 text-[10px] leading-snug',
            off === 0
              ? 'border-[var(--viz-good)]/40 bg-[var(--viz-good)]/10 text-[var(--viz-good)]'
              : 'border-[var(--viz-warning)]/45 bg-[var(--viz-warning)]/10 text-[var(--viz-warning)]',
          )}
        >
          {off === 0
            ? 'Matches the advice note.'
            : off > 0
              ? `${off} unit${off === 1 ? '' : 's'} over the advice note — the extra is still received and put away.`
              : `${Math.abs(off)} unit${off === -1 ? '' : 's'} short — the shortfall stays open against ${receipt.po}.`}
        </div>

        <div className="mt-1 flex gap-1.5">
          {[line.expectedQty, Math.floor(line.expectedQty / 2), 0].map((preset, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setCounted(String(preset))}
              className="btn flex-1 !px-1 !py-1 !text-[10px]"
            >
              {i === 0 ? 'All advised' : i === 1 ? 'Half' : 'None'}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-2.5 flex gap-2">
        <button
          type="button"
          onClick={() => receiveLine(receipt.id, line.id, qty)}
          disabled={!valid}
          className="btn btn-primary flex-1"
        >
          Receive {qty} ea →
        </button>
        <button type="button" onClick={cancelPutaway} className="btn" title="Back to the list">
          ←
        </button>
      </div>
    </Card>
  )
}

/**
 * Counted as zero — the line was on the advice note but nothing turned up.
 *
 * Distinct from having nowhere to put it: there is nothing to put anywhere, and
 * the useful next move is to re-count rather than to hunt for space.
 */
function NothingReceivedCard() {
  const activeLine = useAppStore((s) => s.activeLine)
  const receipts = useAppStore((s) => s.receipts)
  const recountLine = useAppStore((s) => s.recountLine)
  const cancelPutaway = useAppStore((s) => s.cancelPutaway)

  const receipt = receipts.find((r) => r.id === activeLine?.receiptId)
  const line = receipt?.lines.find((l) => l.id === activeLine?.lineId)
  if (!receipt || !line) return null

  return (
    <Card title="Nothing received" dense action={<span className="chip">{receipt.ref}</span>}>
      <div className="rounded-lg border border-[var(--viz-warning)]/45 bg-[var(--viz-warning)]/10 p-2.5">
        <div className="truncate text-[11.5px] font-medium text-ink-100">{line.name}</div>
        <div className="mt-0.5 text-[10px] leading-snug text-ink-300">
          Counted as zero against {line.expectedQty} advised. The whole line stays open on{' '}
          {receipt.po} — there is nothing to put away.
        </div>
      </div>
      <div className="mt-2.5 flex gap-2">
        <button type="button" onClick={recountLine} className="btn btn-primary flex-1">
          Count it again
        </button>
        <button type="button" onClick={cancelPutaway} className="btn">
          Back to the list
        </button>
      </div>
    </Card>
  )
}

/** Received, but the facility has nowhere legal to put it. */
function NoSpaceCard() {
  const activeLine = useAppStore((s) => s.activeLine)
  const receipts = useAppStore((s) => s.receipts)
  const cancelPutaway = useAppStore((s) => s.cancelPutaway)
  const line = activeLine
    ? receipts.find((r) => r.id === activeLine.receiptId)?.lines.find((l) => l.id === activeLine.lineId)
    : undefined

  return (
    <Card title="Nowhere to put it" dense>
      <EmptyState
        title={line ? `${outstandingUnits(line)} units with no location` : 'No location'}
        body={
          line?.skuId
            ? 'Its home location is full and every empty location is taken. Free one up, or ship some stock out first.'
            : 'Every location is occupied, so a line new to the facility cannot be slotted. Free one up first.'
        }
      />
      <button type="button" onClick={cancelPutaway} className="btn mt-2 w-full">
        ← Back to the list
      </button>
    </Card>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-[10px] font-medium text-ink-400">{label}</span>
      {children}
      {hint && <span className="block text-[9.5px] leading-snug text-ink-500">{hint}</span>}
    </label>
  )
}

// ── step 2: auto or manual ────────────────────────────────────────────────────

type SortBy = 'score' | 'distance'

/** Rows rendered before the list asks you to narrow the search. */
const MAX_ROWS = 80

function LocationStep() {
  const model = useAppStore((s) => s.model)
  const engine = useAppStore((s) => s.engine)
  const plan = useAppStore((s) => s.putawayPlan)!
  const receipts = useAppStore((s) => s.receipts)
  const mode = useAppStore((s) => s.locationMode)
  const stockVersion = useAppStore((s) => s.stockVersion)
  const setLocationMode = useAppStore((s) => s.setLocationMode)
  const chooseLocation = useAppStore((s) => s.chooseLocation)
  const confirmLocation = useAppStore((s) => s.confirmLocation)
  const cancelPutaway = useAppStore((s) => s.cancelPutaway)

  const [search, setSearch] = useState('')
  const [aisle, setAisle] = useState('all')
  const [sortBy, setSortBy] = useState<SortBy>('score')

  const line = receipts
    .find((r) => r.id === plan.receiptId)
    ?.lines.find((l) => l.id === plan.lineId)
  const outstanding = line ? outstandingUnits(line) : 0

  // Every legal location, not just the shortlist — the manual picker has to be
  // able to see all of the free space, which is the whole point of choosing.
  const all = useMemo(() => {
    if (!model || !engine || !line) return []
    return listAvailable(model, engine.routingContext, {
      skuId: line.skuId,
      velocity: line.velocity,
      qty: outstanding,
      unitVolume: line.unitVolume,
    })
    // `stockVersion` invalidates after a putaway changes what is free.
  }, [model, engine, line, outstanding, stockVersion])

  const aisles = useMemo(
    () => [...new Set(all.map((c) => c.bin.aisle))].sort((a, b) => a - b),
    [all],
  )

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase()
    const rows = all.filter(
      (c) =>
        (aisle === 'all' || c.bin.aisle === Number(aisle)) &&
        (q === '' || c.code.toUpperCase().includes(q)),
    )
    return sortBy === 'distance' ? [...rows].sort((a, b) => a.distance - b.distance) : rows
  }, [all, search, aisle, sortBy])

  const chosen = plan.candidates.find((c) => c.binId === plan.chosenBinId)
  const emptyCount = all.filter((c) => c.fit === 'empty').length

  return (
    <Card
      title="Where should it go?"
      dense
      action={<span className="chip">{all.length} available</span>}
    >
      {line && (
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <span className="truncate text-[11px] font-medium text-ink-100">{line.name}</span>
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-400">
            {outstanding} ea
          </span>
        </div>
      )}

      <Segmented
        value={mode}
        options={[
          { value: 'auto' as const, label: 'Auto — best match' },
          { value: 'manual' as const, label: 'Choose myself' },
        ]}
        onChange={setLocationMode}
      />

      {mode === 'auto' ? (
        chosen && <RecommendedLocation candidate={chosen} />
      ) : (
        <div className="mt-2 space-y-2">
          <p className="text-[9.5px] leading-snug text-ink-400">
            {emptyCount} empty location{emptyCount === 1 ? '' : 's'}
            {all.length > emptyCount ? ' plus its home location' : ''} can take this line. Pick one
            — the scene highlights it as you go.
          </p>

          <div className="flex gap-1.5">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by code…"
              spellCheck={false}
              className={INPUT}
            />
            <select
              value={aisle}
              onChange={(e) => setAisle(e.target.value)}
              className={cx(INPUT, '!w-auto shrink-0')}
              aria-label="Filter by aisle"
            >
              <option value="all">All aisles</option>
              {aisles.map((a) => (
                <option key={a} value={a}>
                  A{String(a + 1).padStart(2, '0')}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-[9.5px] text-ink-500">
              {filtered.length} match{filtered.length === 1 ? '' : 'es'}
            </span>
            <Segmented
              value={sortBy}
              size="sm"
              options={[
                { value: 'score' as const, label: 'Best' },
                { value: 'distance' as const, label: 'Nearest' },
              ]}
              onChange={setSortBy}
            />
          </div>

          {filtered.length === 0 ? (
            <EmptyState title="Nothing matches" body="Widen the filter or clear the aisle." />
          ) : (
            <div className="max-h-[280px] space-y-1 overflow-y-auto pr-0.5">
              {filtered.slice(0, MAX_ROWS).map((c) => (
                <LocationRow
                  key={c.binId}
                  candidate={c}
                  selected={c.binId === plan.chosenBinId}
                  onSelect={() => chooseLocation(c.binId)}
                />
              ))}
              {filtered.length > MAX_ROWS && (
                <p className="pt-1 text-center text-[9.5px] text-ink-500">
                  +{filtered.length - MAX_ROWS} more — filter by code or aisle.
                </p>
              )}
            </div>
          )}

          {chosen && (
            <div className="rounded-md border border-accent/40 bg-accent/5 px-2 py-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-mono text-[12px] font-semibold text-accent-soft">
                  {chosen.code}
                </span>
                <span className="font-mono text-[9.5px] tabular-nums text-ink-400">
                  {chosen.fits} ea · {Math.round(chosen.distance)} m
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-2.5 flex gap-2">
        <button
          type="button"
          onClick={confirmLocation}
          disabled={!chosen}
          className="btn btn-primary flex-1"
        >
          Show me the route →
        </button>
        <button type="button" onClick={cancelPutaway} className="btn" title="Back to product">
          ←
        </button>
      </div>
    </Card>
  )
}

function RecommendedLocation({ candidate }: { candidate: PutawayCandidate }) {
  return (
    <div className="mt-2">
      <div className="rounded-lg border border-accent/40 bg-accent/5 p-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-mono text-[15px] font-semibold text-accent-soft">
            {candidate.code}
          </span>
          <span className="chip !text-[8.5px]">
            {candidate.fit === 'topUp' ? 'top-up' : 'empty location'}
          </span>
        </div>
        <div className="mt-1.5 grid grid-cols-3 gap-2 text-[10px]">
          <Metric label="Will place" value={`${candidate.fits} ea`} />
          <Metric label="Walk" value={`${Math.round(candidate.distance)} m`} />
          <Metric label="Score" value={String(candidate.score)} />
        </div>
      </div>

      <ul className="mt-2 space-y-1">
        {candidate.reasons.map((reason) => (
          <li key={reason} className="flex gap-1.5 text-[10px] leading-snug text-ink-300">
            <span className="shrink-0 text-[var(--viz-good)]">✓</span>
            <span>{reason}</span>
          </li>
        ))}
        {candidate.warnings.map((warning) => (
          <li
            key={warning}
            className="flex gap-1.5 text-[10px] leading-snug text-[var(--viz-warning)]"
          >
            <span className="shrink-0">!</span>
            <span>{warning}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function LocationRow({
  candidate,
  selected,
  onSelect,
}: {
  candidate: PutawayCandidate
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cx(
        'flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-all duration-150',
        selected
          ? 'option-active'
          : 'border-ink-700/70 bg-ink-850/50 hover:border-ink-600 hover:bg-ink-750',
      )}
    >
      <div className="min-w-0 flex-1">
        <div
          className={cx(
            'truncate font-mono text-[10.5px]',
            selected ? 'text-accent-soft' : 'text-ink-100',
          )}
        >
          {candidate.code}
        </div>
        <div className="truncate text-[9px] text-ink-400">
          {candidate.fit === 'topUp' ? 'top-up' : 'empty'} · holds {candidate.fits} ea · L
          {candidate.bin.level + 1}
        </div>
      </div>
      <span className="shrink-0 font-mono text-[9.5px] tabular-nums text-ink-400">
        {Math.round(candidate.distance)} m
      </span>
      <span
        className={cx(
          'w-6 shrink-0 text-right font-mono text-[10px] tabular-nums',
          selected ? 'text-accent-soft' : 'text-ink-500',
        )}
      >
        {candidate.score}
      </span>
    </button>
  )
}

// ── step 3: the walk ──────────────────────────────────────────────────────────

function RouteStep() {
  const plan = useAppStore((s) => s.putawayPlan)!
  const reopenLocation = useAppStore((s) => s.reopenLocation)
  const beginPlacement = useAppStore((s) => s.beginPlacement)
  const setCameraPreset = useAppStore((s) => s.setCameraPreset)
  const cardRef = useRef<HTMLDivElement>(null)

  const chosen = plan.candidates.find((c) => c.binId === plan.chosenBinId)!

  useEffect(() => {
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [plan.chosenBinId])

  return (
    <div ref={cardRef} className="scroll-mt-3">
      <Card
        title="Route to the location"
        dense
        action={<span className="chip">{metres(plan.route.distance)}</span>}
      >
        <div className="rounded-lg border border-accent/40 bg-accent/5 p-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-mono text-[15px] font-semibold text-accent-soft">
              {chosen.code}
            </span>
            <span className="chip !text-[8.5px]">
              {chosen.fit === 'topUp' ? 'top-up' : 'empty location'}
            </span>
          </div>
          <div className="mt-1.5 grid grid-cols-3 gap-2 text-[10px]">
            <Metric label="Will place" value={`${chosen.fits} ea`} />
            <Metric label="Walk" value={metres(plan.route.distance)} />
            <Metric label="Takes about" value={shortDuration(plan.estimateSec)} />
          </div>
        </div>

        <ol className="mt-2.5 space-y-1.5">
          {plan.directions.map((step) => (
            <li key={step.index} className="flex gap-2">
              <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-ink-700 font-mono text-[9px] font-bold text-ink-100">
                {step.index}
              </span>
              <span className="flex-1 text-[10.5px] leading-snug text-ink-200">{step.text}</span>
              {step.metres > 0 && (
                <span className="shrink-0 font-mono text-[9.5px] tabular-nums text-ink-500">
                  {step.metres} m
                </span>
              )}
            </li>
          ))}
        </ol>

        <p className="mt-2 text-[9.5px] leading-snug text-ink-400">
          Drawn on the floor of the 3D view from Inbound Receiving to the highlighted shelf.{' '}
          <button
            type="button"
            onClick={() => setCameraPreset('top')}
            className="underline hover:text-ink-200"
          >
            See it from above.
          </button>
        </p>

        <div className="mt-2.5 flex gap-2">
          <button type="button" onClick={beginPlacement} className="btn btn-primary flex-1">
            Place product
          </button>
          <button
            type="button"
            onClick={reopenLocation}
            className="btn"
            title="Back to choosing a location"
          >
            ←
          </button>
        </div>
      </Card>
    </div>
  )
}

// ── step 4: the operator walks it ─────────────────────────────────────────────

const PHASE_TEXT: Record<string, string> = {
  walking: 'Carrying the pallet to the location',
  placing: 'Lifting the stock onto the shelf',
  returning: 'Heading back to goods-in',
  done: 'Done',
}

function PlaceStep() {
  const run = useAppStore((s) => s.placementRun)
  const placement = useAppStore((s) => s.lastPlacement)
  const palette = chartPalette(useAppStore((s) => s.theme))
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  // Walking out, stock not yet on the shelf.
  if (run && !placement) {
    const chosen = run.plan.candidates.find((c) => c.binId === run.plan.chosenBinId)
    return (
      <div ref={cardRef} className="scroll-mt-3">
        <Card
          title="Operator on the floor"
          dense
          action={<span className="chip">{pct(run.progress)}</span>}
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-[11px] font-medium text-ink-100">{run.name}</span>
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-400">
              {run.qty} ea
            </span>
          </div>
          <div className="mt-1.5">
            <div className="mb-1 flex justify-between text-[10px]">
              <span className="text-ink-300">{PHASE_TEXT[run.phase]}</span>
              <span className="font-mono tabular-nums text-ink-400">{chosen?.code}</span>
            </div>
            <Bar value={run.progress} color={palette.series[1]} />
          </div>
          <p className="mt-2 text-[9.5px] leading-snug text-ink-400">
            Watch the operator in the 3D view — the stock lands on the shelf when they get there,
            not when you pressed the button. Raise the time scale to speed the walk up.
          </p>
        </Card>
      </div>
    )
  }

  if (!placement) return null
  return (
    <div ref={cardRef} className="scroll-mt-3">
      <PlacedCard />
    </div>
  )
}

function PlacedCard() {
  const placement = useAppStore((s) => s.lastPlacement)!
  const run = useAppStore((s) => s.placementRun)
  const activeLine = useAppStore((s) => s.activeLine)
  const dismissPlacement = useAppStore((s) => s.dismissPlacement)
  const planLine = useAppStore((s) => s.planLine)
  const setSection = useAppStore((s) => s.setSection)

  const partial = placement.remaining > 0

  return (
    <Card
      title={partial ? 'Partly placed' : 'Placed on the shelf'}
      dense
      action={
        <span className={cx('chip', !partial && '!text-[var(--viz-good)]')}>
          {partial ? `${placement.remaining} left` : 'done'}
        </span>
      }
    >
      <div
        className={cx(
          'rounded-lg border p-2.5',
          partial
            ? 'border-[var(--viz-warning)]/45 bg-[var(--viz-warning)]/10'
            : 'border-[var(--viz-good)]/45 bg-[var(--viz-good)]/10',
        )}
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-mono text-[15px] font-semibold text-ink-100">{placement.code}</span>
          <span className="font-mono text-[11px] tabular-nums text-ink-300">
            +{placement.qty} ea
          </span>
        </div>
        <div className="mt-0.5 truncate text-[10.5px] text-ink-300">{placement.name}</div>
      </div>

      <p className="mt-2 text-[10px] leading-snug text-ink-400">
        {run
          ? 'The stock is on the shelf — the operator is walking back to goods-in.'
          : 'The stock is on the shelf. The location is highlighted in the 3D view and now holds this line, so pickers will route to it from the next wave onwards.'}
      </p>

      <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
        <Metric label="Walked" value={metres(placement.distance)} />
        <Metric label="At" value={mmss(placement.at)} />
      </div>

      <div className="mt-2.5 flex gap-2">
        {partial && activeLine ? (
          <button
            type="button"
            onClick={() => planLine(activeLine.receiptId, activeLine.lineId)}
            className="btn btn-primary flex-1"
          >
            Place the remaining {placement.remaining}
          </button>
        ) : (
          <button type="button" onClick={dismissPlacement} className="btn btn-primary flex-1">
            Receive another
          </button>
        )}
        <button type="button" onClick={() => setSection('history')} className="btn">
          History
        </button>
      </div>
    </Card>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-ink-400">{label}</div>
      <div className="truncate font-mono tabular-nums text-ink-100">{value}</div>
    </div>
  )
}

// ── facility-wide free space, as context under the flow ───────────────────────

type SpaceCut = 'aisle' | 'level' | 'zone'

function FreeSpaceSummaryCard() {
  const model = useAppStore((s) => s.model)
  const stockVersion = useAppStore((s) => s.stockVersion)
  const picks = useAppStore((s) => s.metrics?.totalPicks ?? 0)
  const palette = chartPalette(useAppStore((s) => s.theme))
  const [cut, setCut] = useState<SpaceCut>('aisle')

  // Summing every location is cheap but not free, so it only re-runs when stock
  // has actually moved — a putaway, a reset, or another pick.
  const space = useMemo(
    () => (model ? summariseFreeSpace(model) : null),
    [model, stockVersion, picks],
  )
  if (!space) return null

  const buckets: SpaceBucket[] =
    cut === 'aisle' ? space.byAisle : cut === 'level' ? space.byLevel : space.byVelocity
  const roomiestFirst = [...buckets].sort((a, b) => b.free - a.free)

  return (
    <Card
      title="Free space in the warehouse"
      dense
      action={<span className="chip">{pct(1 - space.occupancy)} free</span>}
    >
      <div className="grid grid-cols-2 gap-2">
        <StatTile
          label="Free capacity"
          value={compact(space.freeUnits)}
          unit="units"
          sub={`of ${compact(space.capacityUnits)} total`}
          tone="accent"
        />
        <StatTile
          label="Empty locations"
          value={String(space.emptyLocations)}
          sub={`of ${space.locations.toLocaleString()} · ready to re-slot`}
        />
      </div>

      <div className="mt-2.5">
        <div className="mb-1 flex justify-between text-[10px]">
          <span className="text-ink-400">Occupancy</span>
          <span className="font-mono tabular-nums text-ink-200">{pct(space.occupancy, 1)}</span>
        </div>
        <Bar
          value={space.occupancy}
          color={space.occupancy > 0.9 ? palette.critical : palette.sequential}
        />
      </div>

      <div className="divider !my-2.5" />

      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wider text-ink-400">Room by</span>
        <Segmented
          value={cut}
          size="sm"
          options={[
            { value: 'aisle' as const, label: 'Aisle' },
            { value: 'level' as const, label: 'Level' },
            { value: 'zone' as const, label: 'Zone' },
          ]}
          onChange={setCut}
        />
      </div>

      <div className="space-y-1.5">
        {roomiestFirst.map((b) => (
          <div key={b.key}>
            <div className="mb-0.5 flex justify-between text-[10px]">
              <span className="text-ink-300">{b.label}</span>
              <span className="font-mono tabular-nums text-ink-400">
                {compact(b.free)} free · {b.empty} empty
              </span>
            </div>
            <Bar
              value={b.occupancy}
              color={b.occupancy > 0.9 ? palette.critical : palette.barBase}
            />
          </div>
        ))}
      </div>
    </Card>
  )
}

/** What is being kept in this browser, and how to get rid of it. */
function StorageFooter() {
  const saved = useAppStore((s) => Object.keys(s.binOverrides).length)
  const receipts = useAppStore((s) => s.receipts.length)
  const clearSavedData = useAppStore((s) => s.clearSavedData)

  return (
    <div className="flex items-center gap-2 px-1 pb-1 text-[9.5px] text-ink-500">
      <span className="flex-1 leading-snug">
        Saved in this browser: {receipts} receipt{receipts === 1 ? '' : 's'}, {saved} restocked
        location{saved === 1 ? '' : 's'}.
      </span>
      <button
        type="button"
        onClick={clearSavedData}
        className="shrink-0 underline hover:text-ink-300"
      >
        Clear
      </button>
    </div>
  )
}
