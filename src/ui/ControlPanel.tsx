import { useRef, useState } from 'react'
import { SAMPLE_ORDERS_DOC } from '../data'
import { ROUTING_STRATEGIES } from '../pathfinding/strategies'
import { MAX_AGENTS } from '../simulation/engine'
import { PICKER_KINDS, PICKER_PROFILES, profileFor } from '../simulation/pickerProfiles'
import { useAppStore } from '../store/useAppStore'
import { VELOCITY_LABEL, velocityHex } from '../scene/theme'
import { Card, Segmented, Slider, Toggle, cx } from './components/primitives'

const SHORT_KIND: Record<string, string> = {
  person: 'Person',
  cart: 'Pick cart',
  palletJack: 'Pallet truck',
  amr: 'AMR robot',
}

/** Tiny inline silhouette so each embodiment is identifiable in the selector. */
function PickerGlyph({ kind, active }: { kind: string; active: boolean }) {
  const stroke = active ? '#67e8f9' : '#8b9aab'
  return (
    <svg width="14" height="16" viewBox="0 0 14 16" fill="none" aria-hidden className="shrink-0">
      {kind === 'amr' ? (
        <>
          <rect x="1.5" y="7" width="11" height="6" rx="1.4" stroke={stroke} strokeWidth="1.3" />
          <path d="M4 7V4.5h6V7" stroke={stroke} strokeWidth="1.3" />
          <circle cx="7" cy="2.6" r="1" fill={stroke} />
        </>
      ) : (
        <>
          <circle cx="5" cy="2.8" r="1.9" stroke={stroke} strokeWidth="1.3" />
          <path d="M5 4.9v4.3M5 9.2 3.2 14M5 9.2 6.8 14M2.6 6.4h4.8" stroke={stroke} strokeWidth="1.3" />
          {kind === 'cart' && (
            <rect x="8.8" y="7.4" width="4.4" height="5" rx="0.8" stroke={stroke} strokeWidth="1.3" />
          )}
          {kind === 'palletJack' && (
            <>
              <rect x="8.4" y="6.2" width="5" height="4" rx="0.6" stroke={stroke} strokeWidth="1.3" />
              <path d="M8.2 12.6h5.4" stroke={stroke} strokeWidth="1.3" />
            </>
          )}
          {kind === 'person' && (
            <rect x="7.6" y="8" width="3.4" height="3" rx="0.6" stroke={stroke} strokeWidth="1.3" />
          )}
        </>
      )}
    </svg>
  )
}

export function ControlPanel() {
  const settings = useAppStore((s) => s.settings)
  const orderGen = useAppStore((s) => s.orderGen)
  const orders = useAppStore((s) => s.orders)
  const metrics = useAppStore((s) => s.metrics)
  const binColorMode = useAppStore((s) => s.binColorMode)
  const showPaths = useAppStore((s) => s.showPaths)
  const showSequence = useAppStore((s) => s.showSequence)

  const updateSettings = useAppStore((s) => s.updateSettings)
  const setOrderGen = useAppStore((s) => s.setOrderGen)
  const regenerateOrders = useAppStore((s) => s.regenerateOrders)
  const loadSampleOrders = useAppStore((s) => s.loadSampleOrders)
  const importOrdersJson = useAppStore((s) => s.importOrdersJson)
  const clearOrders = useAppStore((s) => s.clearOrders)
  const setBinColorMode = useAppStore((s) => s.setBinColorMode)
  const toggle = useAppStore((s) => s.toggle)

  const [importText, setImportText] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const totalLines = orders.reduce((s, o) => s + o.lines.length, 0)
  const profile = profileFor(settings.pickerKind)
  const VELOCITY_HEX = velocityHex(useAppStore((s) => s.theme))
  const aisles = useAppStore((s) => s.model?.config.aisles ?? 0)
  // How crowded the module is about to get, in the operator's own terms.
  const aislesPerPicker = aisles > 0 ? (aisles / settings.agentCount).toFixed(1) : '—'

  const onFile = (file: File | undefined) => {
    if (!file) return
    file.text().then((text) => {
      setImportText(text)
      importOrdersJson(text)
    })
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <Card title="Routing strategy">
        <div className="space-y-1.5">
          {ROUTING_STRATEGIES.map((strategy) => {
            const active = settings.strategyId === strategy.id
            return (
              <button
                key={strategy.id}
                type="button"
                onClick={() => updateSettings({ strategyId: strategy.id })}
                className={cx(
                  'w-full rounded-lg border px-2.5 py-2 text-left transition-all duration-150',
                  active
                    ? 'option-active'
                    : 'border-ink-700 bg-ink-850 hover:border-ink-600 hover:bg-ink-750',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={cx(
                      'text-[11.5px] font-semibold',
                      active ? 'text-accent-soft' : 'text-ink-100',
                    )}
                  >
                    {strategy.name}
                  </span>
                  {active && (
                    <span className="text-[9px] font-bold uppercase tracking-wider text-accent">
                      active
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-[10px] leading-snug text-ink-400">{strategy.blurb}</p>
              </button>
            )
          })}
        </div>
        {metrics?.running && (
          <p className="mt-2 text-[10px] leading-snug text-ink-400">
            In-flight routes keep their original plan — the new strategy applies to the next order
            assigned.
          </p>
        )}
      </Card>

      <Card
        title="Picker type"
        action={<span className="chip">{profile.capacityLines} lines / tour</span>}
      >
        <div className="grid grid-cols-2 gap-1.5">
          {PICKER_KINDS.map((kind) => {
            const p = PICKER_PROFILES[kind]
            const active = settings.pickerKind === kind
            return (
              <button
                key={kind}
                type="button"
                onClick={() => updateSettings({ pickerKind: kind })}
                title={p.blurb}
                className={cx(
                  'rounded-lg border px-2 py-2 text-left transition-all duration-150',
                  active
                    ? 'option-active'
                    : 'border-ink-700 bg-ink-850 hover:border-ink-600 hover:bg-ink-750',
                )}
              >
                <div className="flex items-center gap-1.5">
                  <PickerGlyph kind={kind} active={active} />
                  <span
                    className={cx(
                      'text-[10.5px] font-semibold leading-tight',
                      active ? 'text-accent-soft' : 'text-ink-100',
                    )}
                  >
                    {SHORT_KIND[kind]}
                  </span>
                </div>
                <div className="mt-1 flex gap-2 font-mono text-[9px] tabular-nums text-ink-400">
                  <span>{(p.speedFactor * settings.pickerSpeed).toFixed(2)} m/s</span>
                  <span>·</span>
                  <span>{p.capacityLines} ln</span>
                </div>
              </button>
            )
          })}
        </div>
        <p className="mt-2 text-[10px] leading-snug text-ink-400">{profile.blurb}</p>
      </Card>

      <Card title="Labour & fleet">
        <div className="space-y-3.5">
          <Slider
            label="Pickers on the floor"
            value={settings.agentCount}
            min={1}
            max={MAX_AGENTS}
            onChange={(v) => updateSettings({ agentCount: v })}
            hint={
              settings.agentCount > 8
                ? `Above 8 the identity colours repeat — the P-number is the identity. ${aislesPerPicker} aisle per picker.`
                : 'More pickers raise throughput but also aisle congestion.'
            }
          />
          <Slider
            label="Base walking speed"
            value={settings.pickerSpeed}
            min={0.6}
            max={2.2}
            step={0.05}
            suffix=" m/s"
            format={(v) => v.toFixed(2)}
            onChange={(v) => updateSettings({ pickerSpeed: v })}
            hint={`× ${profile.speedFactor.toFixed(2)} for ${SHORT_KIND[settings.pickerKind]} = ${(settings.pickerSpeed * profile.speedFactor).toFixed(2)} m/s`}
          />
          <Slider
            label="Handling time per line"
            value={settings.pickTimeSec}
            min={3}
            max={40}
            step={1}
            suffix=" s"
            onChange={(v) => updateSettings({ pickTimeSec: v })}
          />
          <Slider
            label="Time per unit"
            value={settings.perUnitTimeSec}
            min={0}
            max={10}
            step={0.1}
            suffix=" s"
            format={(v) => v.toFixed(1)}
            onChange={(v) => updateSettings({ perUnitTimeSec: v })}
          />
          <Slider
            label="Pack-out per order"
            value={settings.unloadTimeSec}
            min={0}
            max={120}
            step={5}
            suffix=" s"
            onChange={(v) => updateSettings({ unloadTimeSec: v })}
          />
          <Slider
            label="Congestion radius"
            value={settings.congestionRadius}
            min={0.8}
            max={6}
            step={0.1}
            suffix=" m"
            format={(v) => v.toFixed(1)}
            onChange={(v) => updateSettings({ congestionRadius: v })}
            hint="Pickers this close yield to each other and log a congestion event."
          />
        </div>
      </Card>

      <Card title="Operating behaviour">
        <p className="mb-2 text-[10px] leading-relaxed text-ink-400">
          What the pickers are allowed to reason about. Turn one off to see what it was worth —
          every switch shows up in the metrics.
        </p>
        <div className="space-y-1">
          <Toggle
            label="Smart dispatch"
            checked={settings.smartDispatch}
            onChange={(v) => updateSettings({ smartDispatch: v })}
            hint="Weigh SLA urgency against walking distance instead of plain FIFO."
          />
          <Toggle
            label="Batch picking"
            checked={settings.batchOrders}
            onChange={(v) => updateSettings({ batchOrders: v })}
            hint={`Combine nearby orders up to ${profile.capacityLines} lines in one tour.`}
          />
          <Toggle
            label="Congestion re-routing"
            checked={settings.rerouting}
            onChange={(v) => updateSettings({ rerouting: v })}
            hint="Defer picks in a blocked aisle and come back, instead of waiting."
          />
          <Toggle
            label="Stock depletion & shorts"
            checked={settings.stockDepletion}
            onChange={(v) => updateSettings({ stockDepletion: v })}
            hint="On-hand falls as picks happen; empty locations short and flag replen."
          />
          <Toggle
            label="Rest breaks & fatigue"
            checked={settings.restBreaks}
            onChange={(v) => updateSettings({ restBreaks: v })}
            hint="A 5 min break every 55 min worked, plus mild pace decay."
          />
        </div>
      </Card>

      <Card
        title="Order generator"
        action={
          <span className="chip">
            {orders.length} orders · {totalLines} lines
          </span>
        }
      >
        <div className="space-y-3.5">
          <Slider
            label="Batch size"
            value={orderGen.count}
            min={1}
            max={120}
            onChange={(v) => setOrderGen({ count: v })}
          />
          <Slider
            label="Lines per order (min)"
            value={orderGen.minLines}
            min={1}
            max={Math.max(1, orderGen.maxLines)}
            onChange={(v) => setOrderGen({ minLines: v })}
          />
          <Slider
            label="Lines per order (max)"
            value={orderGen.maxLines}
            min={orderGen.minLines}
            max={40}
            onChange={(v) => setOrderGen({ maxLines: v })}
          />
          <Slider
            label="Arrival rate"
            value={orderGen.arrivalPerMin}
            min={0.5}
            max={60}
            step={0.5}
            suffix=" /min"
            format={(v) => v.toFixed(1)}
            onChange={(v) => setOrderGen({ arrivalPerMin: v })}
            hint="Poisson arrivals — orders release in realistic bursts."
          />

          <div className="flex gap-2">
            <button type="button" onClick={regenerateOrders} className="btn btn-primary flex-1">
              Generate batch
            </button>
            <button type="button" onClick={() => void loadSampleOrders()} className="btn">
              Sample wave
            </button>
          </div>

          <button
            type="button"
            onClick={clearOrders}
            className="btn w-full"
            disabled={orders.length === 0}
          >
            Clear order queue
          </button>
        </div>
      </Card>

      <Card
        title="Import real data"
        action={
          <button
            type="button"
            onClick={() => setImportOpen((v) => !v)}
            className="btn btn-icon"
            aria-expanded={importOpen}
          >
            {importOpen ? '−' : '+'}
          </button>
        }
      >
        {importOpen ? (
          <div className="space-y-2">
            <p className="text-[10px] leading-relaxed text-ink-400">
              Paste a JSON array of orders, or upload a file. Locations accept an operator code
              (<span className="font-mono text-ink-300">A03-R14-2B</span>), a bin id or a SKU id.
            </p>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              spellCheck={false}
              placeholder={'[{ "ref": "SO-1001", "lines": [{ "location": "A03-R14-2B", "qty": 2 }] }]'}
              className="h-28 w-full resize-y rounded-lg border border-ink-700 bg-ink-850 p-2 font-mono text-[10px] leading-relaxed text-ink-100 outline-none transition-colors placeholder:text-ink-500 focus:border-accent"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => importOrdersJson(importText)}
                className="btn btn-primary flex-1"
                disabled={importText.trim().length === 0}
              >
                Load orders
              </button>
              <button type="button" onClick={() => fileRef.current?.click()} className="btn">
                Upload .json
              </button>
            </div>
            <button
              type="button"
              onClick={() => setImportText(JSON.stringify(SAMPLE_ORDERS_DOC, null, 2))}
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

      <Card title="Scene options">
        <div className="space-y-3">
          <div>
            <div className="field-label mb-1.5">
              <span>Colour bins by</span>
            </div>
            <Segmented
              value={binColorMode}
              size="sm"
              options={[
                { value: 'velocity' as const, label: 'SKU velocity' },
                { value: 'zone' as const, label: 'Aisle zone' },
              ]}
              onChange={setBinColorMode}
            />
          </div>

          {binColorMode === 'velocity' && (
            <div className="space-y-1">
              {(['fast', 'medium', 'slow'] as const).map((tier) => (
                <div key={tier} className="flex items-center gap-1.5 text-[10px] text-ink-400">
                  <span className="h-2 w-2 rounded-sm" style={{ background: VELOCITY_HEX[tier] }} />
                  {VELOCITY_LABEL[tier]}
                </div>
              ))}
            </div>
          )}

          <div className="divider !my-2" />

          <Toggle
            label="Show pick paths"
            checked={showPaths}
            onChange={() => toggle('showPaths')}
            hint="Planned route dim, walked route bright."
          />
          <Toggle
            label="Numbered pick sequence"
            checked={showSequence}
            onChange={() => toggle('showSequence')}
            hint="Markers on the focused picker's route."
          />
        </div>
      </Card>
    </div>
  )
}
