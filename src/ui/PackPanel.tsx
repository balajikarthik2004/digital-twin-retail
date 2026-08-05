import type { Order } from '../simulation/types'
import { channelHex } from '../scene/theme'
import { useAppStore } from '../store/useAppStore'
import { Bar, Card, EmptyState, StatTile, cx } from './components/primitives'
import {
  PACK_PHASE_LABEL,
  PACK_PHASE_TONE,
  PARCEL_STAGE_LABEL,
  pct,
  shortDuration,
} from './format'
import { chartPalette } from './theme'

/**
 * Pack-out & dispatch dashboard.
 *
 * The point of these three cards is to answer one question a picking-only view
 * cannot: *where is the order right now?* The flow strip is the whole pipeline in
 * one line, the bench rows show whether packing is the constraint, and the door
 * rows show what has actually left the building.
 */
export function PackPanel() {
  const metrics = useAppStore((s) => s.metrics)
  const settings = useAppStore((s) => s.settings)
  const theme = useAppStore((s) => s.theme)
  const selection = useAppStore((s) => s.selection)
  const setSelection = useAppStore((s) => s.setSelection)
  const palette = chartPalette(theme)
  const CHANNEL_HEX = channelHex(theme)

  if (!metrics) return null

  const bufferLimit = Math.max(1, Math.round(settings.packBufferLimit))
  const inFlight = metrics.parcels.filter((p) => p.stage !== 'dispatched')
  const started = metrics.time > 0

  return (
    <>
      <Card
        title="Pack & dispatch"
        dense
        action={
          <span className="chip">
            {metrics.packStations.filter((s) => s.staffed).length}/{metrics.packStations.length}{' '}
            benches
          </span>
        }
      >
        {/* One line, five stages: the order's whole journey through the building. */}
        <div className="flex items-stretch gap-0.5">
          <FlowStage label="Queued" value={metrics.ordersPending} />
          <FlowArrow />
          <FlowStage label="Picking" value={metrics.ordersInProgress - metrics.ordersAwaitingPack - metrics.ordersPacking - metrics.parcelsInTransit} tone={palette.series[0]} />
          <FlowArrow />
          <FlowStage
            label="Pack"
            value={metrics.ordersAwaitingPack + metrics.ordersPacking}
            tone={palette.series[1]}
            warn={metrics.ordersAwaitingPack >= bufferLimit}
          />
          <FlowArrow />
          <FlowStage label="Belt" value={metrics.parcelsInTransit} tone={palette.series[2]} />
          <FlowArrow />
          <FlowStage label="Shipped" value={metrics.parcelsDispatched} tone={palette.good} />
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <StatTile
            label="Parcels packed"
            value={String(metrics.parcelsPacked)}
            sub={`${metrics.cartonsPacked} cartons · ${metrics.trailersSealed} trailers away`}
            tone="accent"
          />
          <StatTile
            label="Avg pack time"
            value={metrics.parcelsPacked > 0 ? shortDuration(metrics.avgPackSec) : '—'}
            sub={
              metrics.ordersCompleted > 0
                ? `${shortDuration(metrics.avgConveySec)} on the belt`
                : 'per order at the bench'
            }
          />
        </div>

        <div className="mt-2.5 space-y-2">
          <MeterRow
            label="Pack bench utilisation"
            value={metrics.packUtilisation}
            right={started ? pct(metrics.packUtilisation) : '—'}
            color={metrics.packUtilisation > 0.92 ? palette.warning : palette.series[2]}
          />
          <MeterRow
            label="Induction buffer"
            value={metrics.ordersAwaitingPack / bufferLimit}
            right={`${metrics.ordersAwaitingPack}/${bufferLimit} totes`}
            color={
              metrics.ordersAwaitingPack >= bufferLimit ? palette.critical : palette.series[1]
            }
          />
        </div>

        {(metrics.packWaitSeconds > 0 || metrics.mergeBlocks > 0) && (
          <p className="mt-2.5 rounded-lg border border-[var(--viz-warning)]/45 bg-[var(--viz-warning)]/10 px-2 py-1.5 text-[9.5px] leading-snug text-[var(--viz-warning)]">
            {metrics.packWaitSeconds > 0 && (
              <>
                Pickers lost {shortDuration(metrics.packWaitSeconds)} holding totes at a full
                induction buffer (peak {metrics.packBufferPeak}).{' '}
              </>
            )}
            {metrics.mergeBlocks > 0 && (
              <>{metrics.mergeBlocks} parcels were held waiting for a gap on the takeaway line.</>
            )}
          </p>
        )}

        {!settings.conveyorSortation && (
          <p className="mt-2.5 text-[9.5px] leading-snug text-ink-400">
            Conveyor sortation is off — parcels are hand-trucked across the apron, so there is no
            merge contention and no belt to watch.
          </p>
        )}
      </Card>

      <Card title="Pack benches" dense>
        {metrics.packStations.length === 0 ? (
          <EmptyState title="No pack benches in this layout" />
        ) : (
          <div className="space-y-1.5">
            {metrics.packStations.map((station) => (
              <div
                key={station.id}
                className={cx(
                  'rounded-lg border px-2.5 py-2',
                  station.phase === 'mergeBlocked'
                    ? 'border-[var(--viz-critical)]/45 bg-[var(--viz-critical)]/8'
                    : station.staffed
                      ? 'border-ink-700/70 bg-ink-850/50'
                      : 'border-dashed border-ink-700 bg-transparent',
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10.5px] font-semibold text-ink-100">
                    {station.label}
                  </span>
                  <span className={cx('text-[10px] font-medium', PACK_PHASE_TONE[station.phase])}>
                    {PACK_PHASE_LABEL[station.phase]}
                  </span>
                  <span className="flex-1" />
                  <span className="font-mono text-[10px] tabular-nums text-ink-300">
                    {station.ordersPacked} packed
                  </span>
                </div>

                <div className="mt-1.5">
                  <Bar
                    value={station.progress}
                    color={station.phase === 'mergeBlocked' ? palette.critical : palette.series[2]}
                  />
                </div>

                <div className="mt-1.5 flex items-center justify-between gap-2 text-[9.5px] text-ink-400">
                  <span className="truncate font-mono">
                    {station.ref ? (
                      <>
                        {station.ref}
                        {station.channel && (
                          <span
                            className="ml-1.5 inline-block h-1.5 w-1.5 rounded-sm align-middle"
                            style={{ background: CHANNEL_HEX[station.channel as Order['channel']] }}
                          />
                        )}
                      </>
                    ) : station.staffed ? (
                      'no tote on the bench'
                    ) : (
                      'bench closed'
                    )}
                  </span>
                  <span className="shrink-0">
                    {station.avgPackSec > 0 ? `${shortDuration(station.avgPackSec)} avg · ` : ''}
                    {pct(station.utilisation)} busy
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card
        title="Outbound doors"
        dense
        action={<span className="chip">{metrics.parcelsStaged} staged</span>}
      >
        <div className="space-y-1.5">
          {metrics.docks.map((dock) => (
            <div key={dock.id} className="rounded-lg border border-ink-700/70 bg-ink-850/50 px-2.5 py-2">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10.5px] font-semibold text-ink-100">
                  {dock.label}
                </span>
                <span className="flex flex-wrap gap-1">
                  {dock.channels.map((channel) => (
                    <span
                      key={channel}
                      className="chip !normal-case !tracking-normal !text-[9px]"
                      style={{ color: CHANNEL_HEX[channel], borderColor: `${CHANNEL_HEX[channel]}55` }}
                    >
                      {channel}
                    </span>
                  ))}
                </span>
              </div>
              <div className="mt-1.5 flex items-center gap-3 font-mono text-[9.5px] tabular-nums text-ink-400">
                <span>{dock.inbound} inbound</span>
                <span className="text-ink-600">›</span>
                <span className={dock.staged > 0 ? 'text-[var(--viz-warning)]' : undefined}>
                  {dock.staged} staged
                </span>
                <span className="text-ink-600">›</span>
                <span className={dock.dispatched > 0 ? 'text-[var(--viz-good)]' : undefined}>
                  {dock.dispatched} shipped
                </span>
                <span className="flex-1" />
                <span>{dock.trailers} trailers</span>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card
        title="Parcels in the facility"
        dense
        action={<span className="chip">{inFlight.length} live</span>}
      >
        {inFlight.length === 0 ? (
          <EmptyState
            title="Nothing packed yet"
            body="Parcels appear here the moment a bench closes its first carton."
          />
        ) : (
          <div className="space-y-1">
            {inFlight
              .slice()
              .reverse()
              .slice(0, 10)
              .map((parcel) => {
                const active = selection?.kind === 'parcel' && selection.id === parcel.id
                return (
                  <button
                    key={parcel.id}
                    type="button"
                    onClick={() => setSelection({ kind: 'parcel', id: parcel.id })}
                    className={cx(
                      'w-full rounded-lg border px-2 py-1.5 text-left transition-all duration-150',
                      active
                        ? 'border-ink-500 bg-ink-750/70'
                        : 'border-ink-700/60 bg-ink-850/40 hover:border-ink-600',
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      <span
                        className="h-2 w-2 shrink-0 rounded-sm"
                        style={{ background: CHANNEL_HEX[parcel.channel] }}
                      />
                      <span className="font-mono text-[10px] font-medium text-ink-100">
                        {parcel.ref}
                      </span>
                      {parcel.priority === 'express' && (
                        <span className="chip !px-1 !py-0 !text-[8px] !text-[var(--viz-warning)]">
                          express
                        </span>
                      )}
                      <span className="flex-1" />
                      <span
                        className={cx(
                          'text-[9.5px]',
                          parcel.blocked
                            ? 'text-[var(--viz-critical)]'
                            : parcel.stage === 'staged'
                              ? 'text-[var(--viz-good)]'
                              : 'text-ink-400',
                        )}
                      >
                        {parcel.blocked ? 'Held at merge' : PARCEL_STAGE_LABEL[parcel.stage]}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-1.5">
                      <Bar
                        value={parcel.pathLength > 0 ? parcel.arc / parcel.pathLength : 1}
                        color={parcel.blocked ? palette.critical : CHANNEL_HEX[parcel.channel]}
                      />
                      <span className="shrink-0 font-mono text-[9px] tabular-nums text-ink-500">
                        {parcel.cartons}×
                      </span>
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[9px] text-ink-500">
                      {parcel.stationLabel} → {parcel.dockLabel} · {parcel.weightKg} kg
                    </div>
                  </button>
                )
              })}
          </div>
        )}
      </Card>
    </>
  )
}

function FlowStage({
  label,
  value,
  tone,
  warn,
}: {
  label: string
  value: number
  tone?: string
  warn?: boolean
}) {
  const shown = Math.max(0, value)
  return (
    <div
      className={cx(
        'flex-1 rounded-md border px-1 py-1.5 text-center',
        warn
          ? 'border-[var(--viz-critical)]/50 bg-[var(--viz-critical)]/10'
          : shown > 0
            ? 'border-ink-600 bg-ink-850'
            : 'border-ink-700/60 bg-transparent',
      )}
    >
      <div
        className="font-mono text-[13px] font-semibold leading-none tabular-nums"
        style={{ color: shown > 0 ? (warn ? 'var(--viz-critical)' : tone) : undefined }}
      >
        {shown}
      </div>
      <div className="mt-1 text-[8.5px] uppercase tracking-wider text-ink-400">{label}</div>
    </div>
  )
}

function FlowArrow() {
  return <div className="self-center text-[11px] leading-none text-ink-600">›</div>
}

function MeterRow({
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
