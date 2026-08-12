import { useCallback, useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react'
import type { WarehouseScene } from '../scene/WarehouseScene'
import { VELOCITY_LABEL, channelHex, dockFlowHex, velocityHex } from '../scene/theme'
import { DOCK_FLOW_LABEL } from '../simulation/dockActivity'
import { useAppStore } from '../store/useAppStore'
import { useDockState } from './useDockActivity'
import { Bar, cx } from './components/primitives'
import { AlertIcon, CloseIcon, LocationIcon, SnapBackIcon } from './components/icons'
import {
  PARCEL_STAGE_LABEL,
  PHASE_LABEL,
  PHASE_TONE,
  metres,
  mmss,
  pct,
  shortDuration,
} from './format'

/** Keeps a dragged card from being pushed off the edge of the viewport. */
const EDGE_MARGIN = 8

/**
 * Click-to-inspect popover.
 *
 * By default the card tracks the projected screen position of the selected
 * object by writing a CSS transform inside an animation frame — never through
 * React state — so following a moving picker costs nothing per frame.
 *
 * Drag it and it detaches: it stays where you put it, a dashed leader keeps
 * pointing at whatever it is describing, and the position survives clicking
 * from one object to the next. Handy when the card would otherwise sit on top
 * of the thing you are trying to look at.
 */
export function Inspector({ sceneRef }: { sceneRef: RefObject<WarehouseScene | null> }) {
  const cardRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const leaderRef = useRef<HTMLDivElement>(null)
  const lineRef = useRef<SVGLineElement>(null)
  const haloRef = useRef<SVGLineElement>(null)
  const dotRef = useRef<SVGCircleElement>(null)
  /**
   * Detached position in container pixels. A ref, not state: the frame loop
   * reads it every frame and a drag must not re-render the card 60 times a second.
   */
  const posRef = useRef<{ x: number; y: number } | null>(null)
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)
  const [detached, setDetached] = useState(false)
  const selection = useAppStore((s) => s.selection)
  const model = useAppStore((s) => s.model)
  const metrics = useAppStore((s) => s.metrics)
  const setSelection = useAppStore((s) => s.setSelection)
  const theme = useAppStore((s) => s.theme)
  const VELOCITY_HEX = velocityHex(theme)
  const CHANNEL_HEX = channelHex(theme)
  const FLOW_HEX = dockFlowHex(theme)
  const dock = useDockState(selection?.kind === 'dock' ? selection.id : null)

  useEffect(() => {
    if (!selection) return
    let raf = 0
    const track = () => {
      raf = requestAnimationFrame(track)
      const scene = sceneRef.current
      const card = cardRef.current
      const inner = innerRef.current
      if (!scene || !card || !inner) return

      const world = scene.selectionWorldPosition()
      const anchor = world ? scene.project(world) : null
      const free = posRef.current

      if (free) {
        // Parked by the operator: stay put, and let the leader do the pointing.
        card.style.opacity = '1'
        card.style.transform = `translate3d(${Math.round(free.x)}px, ${Math.round(free.y)}px, 0)`
        inner.style.transform = 'none'
        if (leaderRef.current) leaderRef.current.style.display = 'none'
        drawLink(anchor, free, inner)
        return
      }

      if (leaderRef.current) leaderRef.current.style.display = ''
      hideLink()
      if (!anchor) {
        card.style.opacity = '0'
        return
      }
      card.style.opacity = anchor.visible ? '1' : '0'
      card.style.transform = `translate3d(${Math.round(anchor.x)}px, ${Math.round(anchor.y)}px, 0)`

      // Flip below the anchor when there isn't room above, so a bin near the
      // top of the viewport never pushes its card off-screen.
      const height = inner.offsetHeight
      const below = anchor.y < height + 24
      inner.style.transform = below ? 'translate(-50%, 18px)' : `translate(-50%, calc(-100% - 14px))`
      if (leaderRef.current) leaderRef.current.style.order = below ? '-1' : '1'
    }

    /** Dashed connector from the parked card back to the object it describes. */
    const drawLink = (
      anchor: { x: number; y: number; visible: boolean } | null,
      free: { x: number; y: number },
      inner: HTMLElement,
    ) => {
      const line = lineRef.current
      const halo = haloRef.current
      const dot = dotRef.current
      if (!line || !halo || !dot) return
      if (!anchor || !anchor.visible) {
        hideLink()
        return
      }
      const x1 = free.x + inner.offsetWidth / 2
      const y1 = free.y + inner.offsetHeight / 2
      for (const el of [halo, line]) {
        el.style.display = ''
        el.setAttribute('x1', String(x1))
        el.setAttribute('y1', String(y1))
        el.setAttribute('x2', String(anchor.x))
        el.setAttribute('y2', String(anchor.y))
      }
      dot.style.display = ''
      dot.setAttribute('cx', String(anchor.x))
      dot.setAttribute('cy', String(anchor.y))
    }

    const hideLink = () => {
      for (const el of [haloRef.current, lineRef.current, dotRef.current]) {
        if (el) el.style.display = 'none'
      }
    }

    raf = requestAnimationFrame(track)
    return () => cancelAnimationFrame(raf)
  }, [selection, sceneRef])

  // ── dragging ────────────────────────────────────────────────────────────────

  const onDragMove = useCallback((event: globalThis.PointerEvent) => {
    const grab = dragRef.current
    const card = cardRef.current
    const inner = innerRef.current
    const container = card?.parentElement
    if (!grab || !card || !inner || !container) return

    const rect = container.getBoundingClientRect()
    const maxX = rect.width - inner.offsetWidth - EDGE_MARGIN
    const maxY = rect.height - inner.offsetHeight - EDGE_MARGIN
    posRef.current = {
      x: Math.min(Math.max(EDGE_MARGIN, event.clientX - rect.left - grab.dx), Math.max(EDGE_MARGIN, maxX)),
      y: Math.min(Math.max(EDGE_MARGIN, event.clientY - rect.top - grab.dy), Math.max(EDGE_MARGIN, maxY)),
    }
  }, [])

  const onDragEnd = useCallback(() => {
    dragRef.current = null
    window.removeEventListener('pointermove', onDragMove)
    window.removeEventListener('pointerup', onDragEnd)
    window.removeEventListener('pointercancel', onDragEnd)
  }, [onDragMove])

  const onDragStart = (event: PointerEvent<HTMLDivElement>) => {
    // Buttons inside the card keep working; only the card body is a handle.
    if ((event.target as HTMLElement).closest('button')) return
    const inner = innerRef.current
    const container = cardRef.current?.parentElement
    if (!inner || !container) return
    event.preventDefault()

    const rect = container.getBoundingClientRect()
    const card = inner.getBoundingClientRect()
    // Grabbing an anchored card converts its current on-screen spot into a
    // free position, so it does not jump when the drag starts.
    posRef.current = { x: card.left - rect.left, y: card.top - rect.top }
    dragRef.current = { dx: event.clientX - card.left, dy: event.clientY - card.top }
    setDetached(true)
    // Capture so the release lands on the card, never on the canvas underneath —
    // otherwise finishing a drag over the scene can re-pick whatever is there.
    event.currentTarget.setPointerCapture?.(event.pointerId)

    window.addEventListener('pointermove', onDragMove)
    window.addEventListener('pointerup', onDragEnd)
    window.addEventListener('pointercancel', onDragEnd)
  }

  useEffect(() => onDragEnd, [onDragEnd])

  const reattach = () => {
    posRef.current = null
    setDetached(false)
  }

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
  if (!bin && !agent && !parcel && !dock) return null
  const currentTask = agent?.tasks.find((t) => t.status === 'current')
  const needsReplen = bin ? bin.sku.stock <= bin.sku.replenPoint : false
  const transit = parcel
    ? (parcel.stage === 'staged' ? parcel.stagedAt : (metrics?.time ?? 0)) - parcel.packedAt
    : 0

  return (
    <>
      {/*
        Leader from a parked card back to whatever it is describing.

        Drawn twice: a wide stroke in the chrome colour, then the accent line on
        top. The halo is what makes it readable — a thin line on its own vanishes
        against a wall of multicoloured bins. Dashed on purpose, so it can never
        be mistaken for a pick path or a putaway route, which are solid ribbons
        on the floor.
      */}
      <svg className="pointer-events-none absolute inset-0 z-10 h-full w-full" aria-hidden>
        <line
          ref={haloRef}
          stroke="rgb(var(--ink-900))"
          strokeWidth="4.5"
          strokeLinecap="round"
          opacity="0.85"
          style={{ display: 'none' }}
        />
        <line
          ref={lineRef}
          stroke="rgb(var(--accent))"
          strokeWidth="2"
          strokeDasharray="5 4"
          strokeLinecap="round"
          style={{ display: 'none' }}
        />
        <circle
          ref={dotRef}
          r="4"
          fill="rgb(var(--accent))"
          stroke="rgb(var(--ink-900))"
          strokeWidth="1.5"
          style={{ display: 'none' }}
        />
      </svg>

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
          <div
            onPointerDown={onDragStart}
            className="panel-float w-[248px] animate-fade-in cursor-grab select-none p-3 active:cursor-grabbing"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="mini-label">
                  {bin ? 'Storage location' : parcel ? 'Parcel' : dock ? 'Dock door' : 'Picker'}
                </div>
                <div className="truncate font-mono text-sm font-semibold text-ink-100">
                  {bin ? bin.code : parcel ? parcel.ref : dock ? dock.label : agent!.label}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {detached && (
                  <button
                    type="button"
                    onClick={reattach}
                    className="btn btn-icon text-ink-400"
                    title="Snap back to the object"
                    aria-label="Snap card back to the object"
                  >
                    <SnapBackIcon size={12} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setSelection(null)}
                  className="btn btn-icon text-ink-400"
                  title="Close (Esc)"
                  aria-label="Close inspector"
                >
                  <CloseIcon size={11} />
                </button>
              </div>
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
                    color={needsReplen ? 'var(--viz-critical)' : VELOCITY_HEX[bin.sku.velocity]}
                  />
                  {needsReplen && (
                    <div className="mt-1.5 flex items-center gap-1.5 rounded-md border border-crit/45 bg-crit/10 px-1.5 py-1 text-[9.5px] font-medium text-crit">
                      <AlertIcon size={10} className="shrink-0" />
                      At or below replen point — flagged for top-up
                    </div>
                  )}
                </div>
              </div>
            ) : dock ? (
              /*
                The door, both ways round.

                Outbound is always shown because a door always has a sorter lane
                assigned to it, whether or not anything is on the pad. Goods-in is
                only shown when there is a trailer against this door, since an
                empty inbound block on every door would read as a fault.
              */
              <div className="space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className="text-xs font-semibold"
                    style={{ color: FLOW_HEX[dock.flow] }}
                  >
                    {DOCK_FLOW_LABEL[dock.flow]}
                  </span>
                  {dock.inboundQueue > 0 && (
                    <span className="chip !text-[9px]">
                      {dock.inboundQueue} booked in
                    </span>
                  )}
                </div>

                <p className="text-[10.5px] leading-snug text-ink-200">{dock.headline}</p>
                <Bar value={dock.progress} color={FLOW_HEX[dock.flow]} />

                <div>
                  <div className="mb-1 flex justify-between text-[10px] text-ink-400">
                    <span>Trailer load</span>
                    <span className="font-mono tabular-nums text-ink-200">
                      {dock.outbound.staged}/{dock.outbound.capacity} parcels
                    </span>
                  </div>
                  <Bar
                    value={dock.outbound.load}
                    color={dock.outbound.full ? 'var(--viz-critical)' : FLOW_HEX.outbound}
                  />
                  <div className="mt-1 text-[9.5px] text-ink-400">
                    {dock.outbound.staged === 0
                      ? 'Pad clear — nothing waiting to load.'
                      : dock.outbound.full
                        ? 'Full load — the trailer seals on the next step.'
                        : `${dock.outbound.stagedCartons} cartons on the pad · seals in ${shortDuration(dock.outbound.sealIn ?? 0)}.`}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10.5px]">
                  <Row label="On the belt" value={`${dock.outbound.enRoute} parcels`} />
                  <Row label="Shipped" value={`${dock.outbound.dispatched} parcels`} />
                  <Row label="Trailers away" value={String(dock.outbound.trailers)} />
                  <Row label="Cartons away" value={String(dock.outbound.cartons)} />
                </div>

                {dock.outbound.channels.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {dock.outbound.channels.map((channel) => (
                      <span
                        key={channel}
                        className="chip !normal-case !tracking-normal !text-[9px]"
                        style={{
                          color: CHANNEL_HEX[channel],
                          borderColor: `${CHANNEL_HEX[channel]}55`,
                        }}
                      >
                        {channel}
                      </span>
                    ))}
                  </div>
                )}

                {dock.inbound && (
                  <div className="rounded-md border border-ink-700 bg-ink-850/60 px-2 py-1.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[9px] font-semibold uppercase tracking-wider text-ink-400">
                        Goods in
                      </span>
                      <span className="font-mono text-[9.5px] text-ink-300">
                        {dock.inbound.ref}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-[10px] text-ink-200">
                      {dock.inbound.supplier}
                    </div>
                    <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
                      <Row
                        label="Lines counted"
                        value={`${dock.inbound.linesCounted}/${dock.inbound.lines}`}
                      />
                      <Row
                        label="Units counted"
                        value={`${dock.inbound.unitsCounted}/${dock.inbound.unitsAdvised}`}
                      />
                      <Row label="Put away" value={`${dock.inbound.unitsStored} ea`} />
                      <Row label="On the pallet" value={`${dock.inbound.unitsToPutAway} ea`} />
                    </div>
                    <div className="mt-1.5">
                      <Bar value={dock.inbound.progress} color={FLOW_HEX.inbound} />
                    </div>
                    <div className="mt-1 text-[9.5px] text-ink-400">
                      {dock.inbound.atDoor
                        ? `Trailer on the door ${shortDuration(dock.inbound.dwell)} — counting in progress.`
                        : 'Counted in; the putaway is being walked on the floor.'}
                    </div>
                  </div>
                )}
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
                    <span className="chip !px-1 !py-0 !text-[8px] !text-[var(--viz-warning)]">
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
                    color={parcel.blocked ? 'var(--viz-critical)' : CHANNEL_HEX[parcel.channel]}
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

                {/* What this picker has been sent to do, right now. The full
                    tour lives in the pick-task panel on the right rail; the card
                    only ever carries the instruction in hand. */}
                {currentTask && (
                  <button
                    type="button"
                    onClick={() => setSelection({ kind: 'bin', id: currentTask.binId })}
                    className="w-full rounded-md border border-ink-700 bg-ink-850/60 px-2 py-1.5 text-left transition-colors hover:border-ink-600 hover:bg-ink-750/60"
                    title="Show this location"
                  >
                    <div className="flex items-baseline justify-between gap-2 text-[9px] uppercase tracking-wider text-ink-400">
                      <span>Now picking</span>
                      <span>
                        stop {currentTask.sequence}/{agent!.tasks.length}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5">
                      <LocationIcon size={11} className="shrink-0 text-ink-400" />
                      <span className="truncate font-mono text-[11.5px] font-semibold text-ink-100">
                        {currentTask.code}
                      </span>
                      <span className="flex-1" />
                      <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-200">
                        {currentTask.qty} ea
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-[9.5px] text-ink-400">
                      {currentTask.skuName}
                    </div>
                  </button>
                )}

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
          {/* Short stub leader, used only while the card is anchored. */}
          <div
            ref={leaderRef}
            className="mx-auto h-4 w-px shrink-0 bg-gradient-to-b from-ink-500 to-transparent"
          />
        </div>
      </div>
    </>
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
