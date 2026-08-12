import { MAX_AGENTS } from '../simulation/engine'
import { PICKER_KINDS, PICKER_PROFILES, profileFor } from '../simulation/pickerProfiles'
import { useAppStore } from '../store/useAppStore'
import {
  OCCUPANCY_LABEL,
  VELOCITY_LABEL,
  channelHex,
  occupancyHex,
  velocityHex,
} from '../scene/theme'
import { Card, Segmented, Slider, Toggle, cx } from './components/primitives'
import { shortDuration } from './format'

const SHORT_KIND: Record<string, string> = {
  person: 'Person',
  cart: 'Pick cart',
  palletJack: 'Pallet truck',
  amr: 'AMR robot',
}

/**
 * Tiny inline silhouette so each embodiment is identifiable in the selector.
 *
 * Draws in `currentColor` and picks up its colour from the wrapping element's
 * text colour, same convention as the shared icon set (`components/icons.tsx`)
 * — so it re-themes with light/dark like everything around it, rather than the
 * literal dark-theme hex values it used to carry regardless of mode.
 */
function PickerGlyph({ kind, active }: { kind: string; active: boolean }) {
  return (
    <svg
      width="14"
      height="16"
      viewBox="0 0 14 16"
      fill="none"
      aria-hidden
      className={cx('shrink-0', active ? 'text-accent-soft' : 'text-ink-300')}
    >
      {kind === 'amr' ? (
        <>
          <rect x="1.5" y="7" width="11" height="6" rx="1.4" stroke="currentColor" strokeWidth="1.3" />
          <path d="M4 7V4.5h6V7" stroke="currentColor" strokeWidth="1.3" />
          <circle cx="7" cy="2.6" r="1" fill="currentColor" />
        </>
      ) : (
        <>
          <circle cx="5" cy="2.8" r="1.9" stroke="currentColor" strokeWidth="1.3" />
          <path
            d="M5 4.9v4.3M5 9.2 3.2 14M5 9.2 6.8 14M2.6 6.4h4.8"
            stroke="currentColor"
            strokeWidth="1.3"
          />
          {kind === 'cart' && (
            <rect x="8.8" y="7.4" width="4.4" height="5" rx="0.8" stroke="currentColor" strokeWidth="1.3" />
          )}
          {kind === 'palletJack' && (
            <>
              <rect x="8.4" y="6.2" width="5" height="4" rx="0.6" stroke="currentColor" strokeWidth="1.3" />
              <path d="M8.2 12.6h5.4" stroke="currentColor" strokeWidth="1.3" />
            </>
          )}
          {kind === 'person' && (
            <rect x="7.6" y="8" width="3.4" height="3" rx="0.6" stroke="currentColor" strokeWidth="1.3" />
          )}
        </>
      )}
    </svg>
  )
}

/**
 * Operations section: how the shift is resourced and what the scene shows.
 *
 * Anything about the *goods* — waves in, orders out, what already happened —
 * lives in the Inbound / Outbound / History sections instead.
 */
export function ControlPanel() {
  const settings = useAppStore((s) => s.settings)
  const orders = useAppStore((s) => s.orders)
  const binColorMode = useAppStore((s) => s.binColorMode)
  const showPaths = useAppStore((s) => s.showPaths)
  const showSequence = useAppStore((s) => s.showSequence)
  const showParcels = useAppStore((s) => s.showParcels)
  const showOccupancy = useAppStore((s) => s.showOccupancy)
  const showReserve = useAppStore((s) => s.showReserve)

  const updateSettings = useAppStore((s) => s.updateSettings)
  const setBinColorMode = useAppStore((s) => s.setBinColorMode)
  const toggle = useAppStore((s) => s.toggle)

  const totalLines = orders.reduce((s, o) => s + o.lines.length, 0)
  const profile = profileFor(settings.pickerKind)
  const theme = useAppStore((s) => s.theme)
  const VELOCITY_HEX = velocityHex(theme)
  const CHANNEL_HEX = channelHex(theme)
  const OCCUPANCY_HEX = occupancyHex(theme)
  const aisles = useAppStore((s) => s.model?.config.aisles ?? 0)
  const benches = useAppStore((s) => s.model?.config.packStations ?? 1)
  const conveyorMetres = useAppStore((s) => s.model?.conveyor.trunk.length ?? 0)
  const metrics = useAppStore((s) => s.metrics)

  // A representative order at the current settings, so the sliders read in the
  // units an operator thinks in: seconds per parcel, not abstract factors.
  const sampleLines = orders.length > 0 ? Math.round(totalLines / orders.length) : 5
  const sampleUnits = sampleLines * 2
  const sampleCartons = Math.max(1, Math.ceil(sampleUnits / settings.unitsPerCarton))
  const samplePackSec =
    settings.packSetupSec * (1 + (sampleCartons - 1) * 0.55) +
    settings.packPerLineSec * sampleLines +
    settings.packPerUnitSec * sampleUnits
  // How crowded the module is about to get, in the operator's own terms.
  const aislesPerPicker = aisles > 0 ? (aisles / settings.agentCount).toFixed(1) : '—'

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <Card
        title="Picker type"
        dense
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

      <Card title="Staff allocation" dense>
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
        </div>
      </Card>



      <Card
        title="Pack-out & conveyor"
        dense
        action={
          <span className="chip">
            {settings.packStaff}/{benches} benches
          </span>
        }
      >
        <div className="space-y-3.5">
          <Slider
            label="Packers on shift"
            value={settings.packStaff}
            min={1}
            max={benches}
            onChange={(v) => updateSettings({ packStaff: v })}
            hint={
              settings.packStaff < benches
                ? `${benches - settings.packStaff} bench(es) closed — totes queue at induction and pickers eventually hold.`
                : 'Every bench manned. Pack keeps up until the pick rate exceeds it.'
            }
          />

          <div className="divider !my-2" />

          <Slider
            label="Pack set-up per parcel"
            value={settings.packSetupSec}
            min={5}
            max={60}
            step={1}
            suffix="s"
            onChange={(v) => updateSettings({ packSetupSec: v })}
          />
          <Slider
            label="Check & wrap per line"
            value={settings.packPerLineSec}
            min={1}
            max={20}
            step={0.5}
            suffix="s"
            onChange={(v) => updateSettings({ packPerLineSec: v })}
          />
          <Slider
            label="Units per carton"
            value={settings.unitsPerCarton}
            min={2}
            max={40}
            onChange={(v) => updateSettings({ unitsPerCarton: v })}
            hint={`A typical ${sampleLines}-line order → ${sampleCartons} carton(s), about ${shortDuration(samplePackSec)} on the bench.`}
          />

          <div className="divider !my-2" />

          <Toggle
            label="Conveyor sortation"
            checked={settings.conveyorSortation}
            onChange={(v) => updateSettings({ conveyorSortation: v })}
            hint={
              settings.conveyorSortation
                ? `${Math.round(conveyorMetres)} m loop: takeaway line above the benches, sorter in front of the doors.`
                : 'Off — parcels are hand-trucked across the apron to their door.'
            }
          />
          {settings.conveyorSortation && (
            <Slider
              label="Belt speed"
              value={settings.conveyorSpeed}
              min={0.3}
              max={2}
              step={0.05}
              format={(v) => v.toFixed(2)}
              suffix=" m/s"
              onChange={(v) => updateSettings({ conveyorSpeed: v })}
              hint={
                metrics && metrics.avgConveySec > 0
                  ? `Transit is averaging ${shortDuration(metrics.avgConveySec)} bench to dock.`
                  : 'Slower belts hold parcels longer and delay the SLA clock.'
              }
            />
          )}
          <Slider
            label="Induction buffer"
            value={settings.packBufferLimit}
            min={1}
            max={40}
            onChange={(v) => updateSettings({ packBufferLimit: v })}
            hint="Totes that fit before pickers have to stand and hold their carts."
          />

          <div className="divider !my-2" />

          <div className="space-y-1">
            <div className="field-label mb-1">
              <span>Sorter routing</span>
            </div>
            {(metrics?.docks ?? []).map((dock) => (
              <div key={dock.id} className="flex items-center gap-1.5 text-[10px] text-ink-400">
                <span className="w-14 shrink-0 font-mono text-ink-300">{dock.label}</span>
                <span className="flex flex-wrap gap-1">
                  {dock.channels.length === 0 ? (
                    <span className="text-ink-500">no channel assigned</span>
                  ) : (
                    dock.channels.map((channel) => (
                      <span key={channel} className="inline-flex items-center gap-1">
                        <span
                          className="h-2 w-2 rounded-sm"
                          style={{ background: CHANNEL_HEX[channel] }}
                        />
                        {channel}
                      </span>
                    ))
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      </Card>

      <Card title="Scene options" dense>
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
            label="Flag empty & low locations"
            checked={showOccupancy}
            onChange={() => toggle('showOccupancy')}
            hint="Paints what is missing over the stock colours — where a putaway can go, and what is about to run out."
          />
          {/* The two overlay colours sit outside every categorical palette, so
              they need naming once rather than being guessed at. */}
          {showOccupancy && (
            <div className="space-y-1">
              {(['empty', 'low'] as const).map((state) => (
                <div key={state} className="flex items-center gap-1.5 text-[10px] text-ink-400">
                  <span
                    className="h-2 w-2 rounded-sm ring-1 ring-inset ring-black/20"
                    style={{ background: OCCUPANCY_HEX[state] }}
                  />
                  {OCCUPANCY_LABEL[state]}
                  {state === 'low' && metrics && metrics.replenAlerts > 0 && (
                    <span className="font-mono text-[9.5px] text-[var(--viz-warning)]">
                      {metrics.replenAlerts}
                    </span>
                  )}
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
          <Toggle
            label="Parcels & conveyor motion"
            checked={showParcels}
            onChange={() => toggle('showParcels')}
            hint="Cartons on the belt, stacked at the doors. Click one to inspect it."
          />

          <div className="divider !my-2" />

          <Toggle
            label="Show reserve rack"
            checked={showReserve}
            onChange={() => toggle('showReserve')}
            hint="The bulk-storage tier above the pick face, with its own mezzanine floor and stairs. Hides on its own from directly overhead either way."
          />
        </div>
      </Card>
    </div>
  )
}
