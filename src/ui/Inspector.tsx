import { useEffect, useRef, type RefObject } from 'react'
import type { WarehouseScene } from '../scene/WarehouseScene'
import { VELOCITY_LABEL, channelHex, velocityHex } from '../scene/theme'
import { useAppStore } from '../store/useAppStore'
import { Bar, cx } from './components/primitives'
import {
  PARCEL_STAGE_LABEL,
  PHASE_LABEL,
  PHASE_TONE,
  metres,
  mmss,
  pct,
  shortDuration,
} from './format'

/**
 * Click-to-inspect popover.
 *
 * The card tracks the projected screen position of the selected object by
 * writing a CSS transform inside an animation frame — never through React
 * state — so following a moving picker costs nothing per frame.
 */
export function Inspector({ sceneRef }: { sceneRef: RefObject<WarehouseScene | null> }) {
  const cardRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const leaderRef = useRef<HTMLDivElement>(null)
  const selection = useAppStore((s) => s.selection)
  const model = useAppStore((s) => s.model)
  const metrics = useAppStore((s) => s.metrics)
  const setSelection = useAppStore((s) => s.setSelection)
  const theme = useAppStore((s) => s.theme)
  const VELOCITY_HEX = velocityHex(theme)
  const CHANNEL_HEX = channelHex(theme)

  useEffect(() => {
    if (!selection) return
    let raf = 0
    const track = () => {
      raf = requestAnimationFrame(track)
      const scene = sceneRef.current
      const card = cardRef.current
      if (!scene || !card) return
      const world = scene.selectionWorldPosition()
      if (!world) {
        card.style.opacity = '0'
        return
      }
      const p = scene.project(world)
      card.style.opacity = p.visible ? '1' : '0'
      card.style.transform = `translate3d(${Math.round(p.x)}px, ${Math.round(p.y)}px, 0)`

      // Flip below the anchor when there isn't room above, so a bin near the
      // top of the viewport never pushes its card off-screen.
      const inner = innerRef.current
      if (inner) {
        const height = inner.offsetHeight
        const below = p.y < height + 24
        inner.style.transform = below
          ? 'translate(-50%, 18px)'
          : `translate(-50%, calc(-100% - 14px))`
        if (leaderRef.current) leaderRef.current.style.order = below ? '-1' : '1'
      }
    }
    raf = requestAnimationFrame(track)
    return () => cancelAnimationFrame(raf)
  }, [selection, sceneRef])

  // Escape clears the selection — expected behaviour for an overlay card.
  useEffect(() => {
    if (!selection) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelection(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selection, setSelection])

  if (!selection || !model) return null

  const bin = selection.kind === 'bin' ? model.binsById.get(selection.id) : null
  const agent = selection.kind === 'agent' ? metrics?.agents.find((a) => a.id === selection.id) : null
  const parcel =
    selection.kind === 'parcel' ? metrics?.parcels.find((p) => p.id === selection.id) : null
  if (!bin && !agent && !parcel) return null
  const needsReplen = bin ? bin.sku.stock <= bin.sku.replenPoint : false
  const transit = parcel
    ? (parcel.stage === 'staged' ? parcel.stagedAt : (metrics?.time ?? 0)) - parcel.packedAt
    : 0

  return (
    <div
      ref={cardRef}
      className="pointer-events-none absolute left-0 top-0 z-20 transition-opacity duration-150"
      style={{ opacity: 0 }}
    >
      <div
        ref={innerRef}
        className="pointer-events-auto flex flex-col"
        style={{ transform: 'translate(-50%, calc(-100% - 14px))' }}
      >
        <div className="panel-float w-[248px] animate-fade-in p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-ink-400">
                {bin ? 'Storage location' : parcel ? 'Parcel' : 'Picker'}
              </div>
              <div className="truncate font-mono text-sm font-semibold text-ink-100">
                {bin ? bin.code : parcel ? parcel.ref : agent!.label}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setSelection(null)}
              className="btn btn-icon shrink-0 text-ink-400"
              aria-label="Close inspector"
            >
              ✕
            </button>
          </div>

          <div className="divider" />

          {bin ? (
            <div className="space-y-2.5">
              <div>
                <div className="text-xs font-medium leading-snug text-ink-100">{bin.sku.name}</div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-ink-400">
                  <span className="font-mono">{bin.sku.id}</span>
                  <span className="text-ink-600">·</span>
                  <span>{bin.sku.category}</span>
                </div>
              </div>

              <div className="flex items-center gap-1.5">
                <span
                  className="h-2 w-2 rounded-sm"
                  style={{ background: VELOCITY_HEX[bin.sku.velocity] }}
                />
                <span className="text-[10.5px] font-medium text-ink-200">
                  {VELOCITY_LABEL[bin.sku.velocity]}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10.5px]">
                <Row label="On hand" value={`${bin.sku.stock.toLocaleString()} ea`} />
                <Row label="Replen point" value={`${bin.sku.replenPoint.toLocaleString()} ea`} />
                <Row label="Aisle" value={`A${String(bin.aisle + 1).padStart(2, '0')} · ${bin.side === 'L' ? 'left' : 'right'}`} />
                <Row label="Bay / level" value={`${bin.bay + 1} / L${bin.level + 1}`} />
                <Row label="Typical qty" value={`${bin.sku.unitsPerLine} per line`} />
                <Row label="Unit price" value={`$${bin.sku.price.toFixed(2)}`} />
              </div>

              <div>
                <div className="mb-1 flex justify-between text-[10px] text-ink-400">
                  <span>Stock vs opening</span>
                  <span className="font-mono tabular-nums text-ink-200">
                    {bin.sku.stock.toLocaleString()} / {bin.sku.stockInitial.toLocaleString()}
                  </span>
                </div>
                <Bar
                  value={bin.sku.stockInitial > 0 ? bin.sku.stock / bin.sku.stockInitial : 0}
                  color={needsReplen ? '#d03b3b' : VELOCITY_HEX[bin.sku.velocity]}
                />
                {needsReplen && (
                  <div className="mt-1.5 rounded-md border border-crit/45 bg-crit/10 px-1.5 py-1 text-[9.5px] font-medium text-crit">
                    ! At or below replen point — flagged for top-up
                  </div>
                )}
              </div>
            </div>
          ) : parcel ? (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <span
                  className={cx(
                    'text-xs font-semibold',
                    parcel.blocked
                      ? 'text-[var(--viz-critical)]'
                      : parcel.stage === 'staged'
                        ? 'text-[var(--viz-good)]'
                        : 'text-[var(--viz-series-1)]',
                  )}
                >
                  {parcel.blocked ? 'Held at merge' : PARCEL_STAGE_LABEL[parcel.stage]}
                </span>
                <span className="chip !text-[9px]">
                  {parcel.manual ? 'Hand-trucked' : 'Conveyed'}
                </span>
              </div>

              <div className="flex items-center gap-1.5">
                <span
                  className="h-2 w-2 rounded-sm"
                  style={{ background: CHANNEL_HEX[parcel.channel] }}
                />
                <span className="text-[10.5px] font-medium text-ink-200">{parcel.channel}</span>
                {parcel.priority === 'express' && (
                  <span className="chip !px-1 !py-0 !text-[8.5px] !text-[var(--viz-warning)]">
                    express
                  </span>
                )}
              </div>

              <div>
                <div className="mb-1 flex justify-between text-[10px] text-ink-400">
                  <span>
                    {parcel.stationLabel} → {parcel.dockLabel}
                  </span>
                  <span className="font-mono tabular-nums text-ink-200">
                    {Math.round(parcel.arc)} / {Math.round(parcel.pathLength)} m
                  </span>
                </div>
                <Bar
                  value={parcel.pathLength > 0 ? parcel.arc / parcel.pathLength : 1}
                  color={parcel.blocked ? '#d03b3b' : CHANNEL_HEX[parcel.channel]}
                />
              </div>

              <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10.5px]">
                <Row label="Cartons" value={`${parcel.cartons}`} />
                <Row label="Weight" value={`${parcel.weightKg} kg`} />
                <Row label="Packed at" value={mmss(parcel.packedAt)} />
                <Row
                  label={parcel.stage === 'staged' ? 'Transit took' : 'In transit'}
                  value={shortDuration(transit)}
                />
              </div>

              {parcel.stage === 'staged' && (
                <div className="rounded-md border border-ink-700 bg-ink-850/60 px-2 py-1.5 text-[10px] leading-snug text-ink-200">
                  Stacked in slot {parcel.stackIndex + 1} at {parcel.dockLabel}, waiting for the
                  trailer to seal.
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className={cx('text-xs font-semibold', PHASE_TONE[agent!.phase])}>
                  {PHASE_LABEL[agent!.phase]}
                </span>
                <span className="chip !text-[9px]">{KIND_LABEL[agent!.kind]}</span>
              </div>

              <div className="flex flex-wrap gap-1">
                {agent!.orderRefs.length > 0 ? (
                  agent!.orderRefs.map((ref) => (
                    <span
                      key={ref}
                      className="chip font-mono"
                      style={{ color: agent!.color, borderColor: `${agent!.color}55` }}
                    >
                      {ref}
                    </span>
                  ))
                ) : (
                  <span className="chip">unassigned</span>
                )}
              </div>

              <div>
                <div className="mb-1 flex justify-between text-[10px] text-ink-400">
                  <span>Load</span>
                  <span className="font-mono tabular-nums text-ink-200">
                    {agent!.linesLoaded}/{agent!.capacityLines} lines
                  </span>
                </div>
                <Bar
                  value={agent!.capacityLines > 0 ? agent!.linesLoaded / agent!.capacityLines : 0}
                  color={agent!.color}
                />
              </div>

              {agent!.routeStops > 0 && (
                <div>
                  <div className="mb-1 flex justify-between text-[10px] text-ink-400">
                    <span>
                      Pick {agent!.stopsDone} of {agent!.routeStops}
                    </span>
                    <span className="font-mono tabular-nums">{pct(agent!.progress)} of route</span>
                  </div>
                  <Bar value={agent!.progress} color={agent!.color} />
                </div>
              )}

              <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10.5px]">
                <Row label="Distance" value={metres(agent!.distance)} />
                <Row label="Lines picked" value={String(agent!.picks)} />
                <Row label="Orders done" value={String(agent!.orders)} />
                <Row label="Avg / order" value={agent!.orders > 0 ? mmss(agent!.avgOrderTime) : '—'} />
                <Row label="Utilisation" value={pct(agent!.utilisation)} />
                <Row label="Congestion" value={String(agent!.congestionEvents)} />
                <Row label="Re-routes" value={String(agent!.reroutes)} />
                <Row label="Short picks" value={String(agent!.shortPicks)} />
              </div>

              {agent!.thoughts[0] && (
                <div className="rounded-md border border-ink-700 bg-ink-850/60 px-2 py-1.5">
                  <div className="text-[9px] font-semibold uppercase tracking-wider text-ink-400">
                    Last decision
                  </div>
                  <p className="mt-0.5 text-[10px] leading-snug text-ink-200">
                    {agent!.thoughts[0].text}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
        {/* Leader pointing at the object. */}
        <div
          ref={leaderRef}
          className="mx-auto h-4 w-px shrink-0 bg-gradient-to-b from-ink-500 to-transparent"
        />
      </div>
    </div>
  )
}

const KIND_LABEL: Record<string, string> = {
  person: 'Hand tote',
  cart: 'Pick cart',
  palletJack: 'Pallet truck',
  amr: 'AMR robot',
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-ink-400">{label}</div>
      <div className="truncate font-mono tabular-nums text-ink-100">{value}</div>
    </div>
  )
}
