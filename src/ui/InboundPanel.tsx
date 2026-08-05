import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { summariseFreeSpace, type SpaceBucket } from '../inbound/freeSpace'
import type { PutawayCandidate, Receipt, ReceiptLine } from '../inbound/types'
import { VELOCITY_LABEL, velocityHex } from '../scene/theme'
import { useAppStore } from '../store/useAppStore'
import type { VelocityTier } from '../warehouse/types'
import { Bar, Card, EmptyState, Segmented, StatTile, cx } from './components/primitives'
import { compact, metres, mmss, pct, shortDuration } from './format'
import { chartPalette } from './theme'

/**
 * Inbound section — a three-step flow, in the order the work actually happens:
 *
 *   1. Tell me what you have.
 *   2. Here is the free space for it, and the walk to get there.
 *   3. Proceed — it is on the shelf.
 *
 * The step is derived from store state rather than held separately, so the
 * panel can never disagree with what the 3D scene is drawing.
 */
export function InboundPanel() {
  const plan = useAppStore((s) => s.putawayPlan)
  const placement = useAppStore((s) => s.lastPlacement)
  const activeLine = useAppStore((s) => s.activeLine)

  const step: 1 | 2 | 3 = placement ? 3 : plan ? 2 : 1

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <Stepper step={step} />

      {step === 1 && <ProductDetailsStep noSpace={activeLine !== null} />}
      {step === 2 && (
        <>
          <FreeSpaceFoundStep />
          <RoadmapCard />
        </>
      )}
      {step === 3 && <PlacedStep />}

      <FreeSpaceSummaryCard />
    </div>
  )
}

// ── stepper ───────────────────────────────────────────────────────────────────

const STEPS = ['Product', 'Free space', 'Placed'] as const

function Stepper({ step }: { step: 1 | 2 | 3 }) {
  return (
    <ol className="flex items-center gap-1" aria-label="Inbound progress">
      {STEPS.map((label, i) => {
        const n = (i + 1) as 1 | 2 | 3
        const done = n < step
        const active = n === step
        return (
          <li key={label} className="flex flex-1 items-center gap-1.5">
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
                'truncate text-[10px] font-medium',
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

// ── step 1: what have you got? ────────────────────────────────────────────────

const VELOCITIES: VelocityTier[] = ['fast', 'medium', 'slow']

const INPUT =
  'w-full rounded-lg border border-ink-700 bg-ink-850 px-2 py-1.5 text-[11px] text-ink-100 outline-none transition-colors placeholder:text-ink-500 focus:border-accent'

/**
 * The entry point: nothing is suggested until the product is described.
 *
 * Typing a location code or SKU id switches the form into a top-up — the
 * catalogue already knows that line's size and velocity, so those stop being
 * guesses and the ranker can offer the SKU's own home location.
 */
function ProductDetailsStep({ noSpace }: { noSpace: boolean }) {
  const model = useAppStore((s) => s.model)
  const bookInProduct = useAppStore((s) => s.bookInProduct)
  const theme = useAppStore((s) => s.theme)
  const VELOCITY_HEX = velocityHex(theme)

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
  }

  return (
    <>
      <Card title="What are you receiving?" dense>
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
            Find free space →
          </button>

          {noSpace && (
            <div className="rounded-md border border-crit/45 bg-crit/10 px-2 py-1.5 text-[10px] leading-snug text-crit">
              No legal location for that line — every candidate is full or holds a different SKU.
              Free a location, or receive less of it.
            </div>
          )}
        </div>
      </Card>

      <GoodsInQueueCard />
    </>
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

// ── step 2: here is the space, and the walk to it ─────────────────────────────

function FreeSpaceFoundStep() {
  const plan = useAppStore((s) => s.putawayPlan)!
  const chooseLocation = useAppStore((s) => s.chooseLocation)
  const confirmPutaway = useAppStore((s) => s.confirmPutaway)
  const cancelPutaway = useAppStore((s) => s.cancelPutaway)
  const setSelection = useAppStore((s) => s.setSelection)
  const receipts = useAppStore((s) => s.receipts)

  const chosen = plan.candidates.find((c) => c.binId === plan.chosenBinId)!
  const alternatives = plan.candidates.filter((c) => c.binId !== plan.chosenBinId)

  const line = receipts
    .find((r) => r.id === plan.receiptId)
    ?.lines.find((l) => l.id === plan.lineId)
  const outstanding = line ? line.qty - line.storedQty : chosen.fits

  return (
    <Card
      title="Free space found"
      dense
      action={<span className="chip">score {chosen.score}</span>}
    >
      {line && (
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <span className="truncate text-[11px] font-medium text-ink-100">{line.name}</span>
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-400">
            {outstanding} ea
          </span>
        </div>
      )}

      <div className="rounded-lg border border-accent/40 bg-accent/5 p-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-mono text-[15px] font-semibold text-accent-soft">{chosen.code}</span>
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

      <ul className="mt-2 space-y-1">
        {chosen.reasons.map((reason) => (
          <li key={reason} className="flex gap-1.5 text-[10px] leading-snug text-ink-300">
            <span className="shrink-0 text-[var(--viz-good)]">✓</span>
            <span>{reason}</span>
          </li>
        ))}
        {chosen.warnings.map((warning) => (
          <li
            key={warning}
            className="flex gap-1.5 text-[10px] leading-snug text-[var(--viz-warning)]"
          >
            <span className="shrink-0">!</span>
            <span>{warning}</span>
          </li>
        ))}
      </ul>

      <div className="mt-2.5 flex gap-2">
        <button type="button" onClick={confirmPutaway} className="btn btn-primary flex-1">
          Proceed — place it here
        </button>
        <button type="button" onClick={cancelPutaway} className="btn" title="Back to product details">
          ←
        </button>
      </div>

      {alternatives.length > 0 && (
        <>
          <div className="divider !my-2.5" />
          <div className="mb-1.5 text-[10px] uppercase tracking-wider text-ink-400">
            Other free space
          </div>
          <div className="space-y-1">
            {alternatives.map((c) => (
              <AlternativeRow
                key={c.binId}
                candidate={c}
                onChoose={() => chooseLocation(c.binId)}
                onInspect={() => setSelection({ kind: 'bin', id: c.binId })}
              />
            ))}
          </div>
        </>
      )}
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

function AlternativeRow({
  candidate,
  onChoose,
  onInspect,
}: {
  candidate: PutawayCandidate
  onChoose: () => void
  onInspect: () => void
}) {
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-ink-700/70 bg-ink-850/50 px-2 py-1.5">
      <button
        type="button"
        onClick={onInspect}
        className="min-w-0 flex-1 text-left"
        title="Show this location in the scene"
      >
        <div className="truncate font-mono text-[10.5px] text-ink-100">{candidate.code}</div>
        <div className="truncate text-[9px] text-ink-400">
          {candidate.fit === 'topUp' ? 'top-up' : 'empty'} · {candidate.fits} ea ·{' '}
          {Math.round(candidate.distance)} m
        </div>
      </button>
      <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-400">
        {candidate.score}
      </span>
      <button type="button" onClick={onChoose} className="btn shrink-0 !px-2 !py-1 !text-[10px]">
        Use
      </button>
    </div>
  )
}

function RoadmapCard() {
  const plan = useAppStore((s) => s.putawayPlan)!
  const setCameraPreset = useAppStore((s) => s.setCameraPreset)

  return (
    <Card
      title="Route to the location"
      dense
      action={<span className="chip">{metres(plan.route.distance)}</span>}
    >
      <ol className="space-y-1.5">
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
    </Card>
  )
}

// ── step 3: it is on the shelf ────────────────────────────────────────────────

function PlacedStep() {
  const placement = useAppStore((s) => s.lastPlacement)!
  const activeLine = useAppStore((s) => s.activeLine)
  const dismissPlacement = useAppStore((s) => s.dismissPlacement)
  const planLine = useAppStore((s) => s.planLine)
  const setSection = useAppStore((s) => s.setSection)
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [placement.binId, placement.at])

  const partial = placement.remaining > 0

  return (
    <div ref={cardRef} className="scroll-mt-3">
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
            <span className="font-mono text-[15px] font-semibold text-ink-100">
              {placement.code}
            </span>
            <span className="font-mono text-[11px] tabular-nums text-ink-300">
              +{placement.qty} ea
            </span>
          </div>
          <div className="mt-0.5 truncate text-[10.5px] text-ink-300">{placement.name}</div>
        </div>

        <p className="mt-2 text-[10px] leading-snug text-ink-400">
          The stock is on the shelf in the simulation — the location is highlighted in the 3D view
          and now shows this line. Pickers will route to it from the next wave onwards.
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
    </div>
  )
}

// ── the goods-in queue, as an alternative source of lines ─────────────────────

function GoodsInQueueCard() {
  const receipts = useAppStore((s) => s.receipts)
  const activeLine = useAppStore((s) => s.activeLine)
  const planLine = useAppStore((s) => s.planLine)
  const regenerateReceipts = useAppStore((s) => s.regenerateReceipts)
  const clearReceipts = useAppStore((s) => s.clearReceipts)

  const pendingLines = receipts.reduce(
    (t, r) => t + r.lines.filter((l) => l.status === 'pending').length,
    0,
  )

  return (
    <Card
      title="Or take a line off the goods-in queue"
      dense
      action={
        <span className="chip">
          {receipts.length} GRN · {pendingLines} lines
        </span>
      }
    >
      <div className="mb-2 flex gap-2">
        <button type="button" onClick={regenerateReceipts} className="btn flex-1">
          Book in trailers
        </button>
        <button
          type="button"
          onClick={clearReceipts}
          className="btn"
          disabled={receipts.length === 0}
        >
          Clear
        </button>
      </div>

      {receipts.length === 0 ? (
        <EmptyState
          title="Nothing at the door"
          body="Enter a product above, or generate a schedule of inbound trailers."
        />
      ) : (
        <div className="space-y-2">
          {receipts.map((receipt) => (
            <ReceiptRow
              key={receipt.id}
              receipt={receipt}
              activeLineId={activeLine?.lineId ?? null}
              onPlan={(lineId) => planLine(receipt.id, lineId)}
            />
          ))}
        </div>
      )}
    </Card>
  )
}

function ReceiptRow({
  receipt,
  activeLineId,
  onPlan,
}: {
  receipt: Receipt
  activeLineId: string | null
  onPlan: (lineId: string) => void
}) {
  const done = receipt.lines.every((l) => l.status === 'stored')
  return (
    <div className="rounded-lg border border-ink-700/70 bg-ink-850/40 p-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] font-semibold text-ink-100">{receipt.ref}</span>
        {done && <span className="chip !text-[8.5px] !text-[var(--viz-good)]">stored</span>}
        <span className="flex-1" />
        <span className="font-mono text-[9.5px] tabular-nums text-ink-500">
          {mmss(receipt.arrivedAt)}
        </span>
      </div>
      <div className="mt-0.5 truncate text-[9.5px] text-ink-400">{receipt.supplier}</div>

      <div className="mt-1.5 space-y-1">
        {receipt.lines.map((line) => (
          <LineRow
            key={line.id}
            line={line}
            active={activeLineId === line.id}
            onClick={() => onPlan(line.id)}
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
  const partial = !stored && line.storedQty > 0
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
          {line.qty} ea
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-[9px] text-ink-400">
        {stored ? (
          <span className="text-[var(--viz-good)]">✓ stored at {line.storedCode}</span>
        ) : partial ? (
          <span className="text-[var(--viz-warning)]">
            {line.storedQty} at {line.storedCode} · {line.qty - line.storedQty} left
          </span>
        ) : (
          <span>{line.skuId ? 'top-up · has a home location' : 'new line · needs a location'}</span>
        )}
      </div>
    </button>
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

      <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
        <Fact label="Near full (≥92%)" value={String(space.nearFull)} warn={space.nearFull > 0} />
        <Fact
          label="Below replen point"
          value={String(space.replenFlagged)}
          warn={space.replenFlagged > 0}
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

function Fact({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-lg border border-ink-700/70 bg-ink-850/50 px-2 py-1.5">
      <div className="truncate text-ink-400">{label}</div>
      <div
        className={cx(
          'font-mono text-[13px] font-semibold tabular-nums',
          warn ? 'text-[var(--viz-warning)]' : 'text-ink-100',
        )}
      >
        {value}
      </div>
    </div>
  )
}
