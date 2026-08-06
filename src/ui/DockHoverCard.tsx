import { useEffect, useRef, type RefObject } from 'react'
import type { SceneHover, WarehouseScene } from '../scene/WarehouseScene'
import { dockFlowHex } from '../scene/theme'
import { DOCK_FLOW_LABEL, type DockActivity } from '../simulation/dockActivity'
import { useAppStore } from '../store/useAppStore'
import { Bar, cx } from './components/primitives'
import { shortDuration } from './format'
import { useDockState } from './useDockActivity'

/**
 * Hover read-out for a dock door.
 *
 * A door is a big, static-looking object, so the pointer landing on one has to
 * pay off immediately — waiting for a click to find out that a door is worth
 * clicking is the wrong way round. This is the peek: which way goods are moving,
 * what is being worked and how far through it the door is. The click-through
 * card in the inspector carries the rest.
 *
 * It suppresses itself when the door is already the selection, so hovering the
 * door you have open does not stack two cards on top of each other.
 */
export function DockHoverCard({
  sceneRef,
  hover,
}: {
  sceneRef: RefObject<WarehouseScene | null>
  hover: SceneHover
}) {
  const cardRef = useRef<HTMLDivElement>(null)
  const selection = useAppStore((s) => s.selection)
  const theme = useAppStore((s) => s.theme)
  const FLOW = dockFlowHex(theme)

  const hoveredId = hover?.kind === 'dock' ? hover.id : null
  const suppressed = selection?.kind === 'dock' && selection.id === hoveredId
  const dock = useDockState(suppressed ? null : hoveredId)

  // Follow the door's projected position, in an animation frame rather than
  // through React — the camera moves every frame and the card must not.
  useEffect(() => {
    if (!dock) return
    let raf = 0
    const track = () => {
      raf = requestAnimationFrame(track)
      const scene = sceneRef.current
      const card = cardRef.current
      if (!scene || !card) return
      const world = scene.worldPositionOf({ kind: 'dock', id: dock.id })
      const anchor = world ? scene.project(world) : null
      if (!anchor) {
        card.style.opacity = '0'
        return
      }
      card.style.opacity = anchor.visible ? '1' : '0'
      card.style.transform = `translate3d(${Math.round(anchor.x)}px, ${Math.round(anchor.y)}px, 0)`
    }
    raf = requestAnimationFrame(track)
    return () => cancelAnimationFrame(raf)
  }, [dock, sceneRef])

  if (!dock) return null

  const accent = FLOW[dock.flow]

  return (
    <div
      ref={cardRef}
      className="pointer-events-none absolute left-0 top-0 z-20"
      style={{ opacity: 0 }}
    >
      <div
        className="panel-float w-[236px] animate-fade-in p-2.5"
        style={{ transform: 'translate(-50%, calc(-100% - 12px))' }}
      >
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-[11.5px] font-semibold text-ink-100">
            {dock.label}
          </span>
          <span className="flex-1" />
          <span
            className="chip !normal-case !tracking-normal !text-[9px]"
            style={{ color: accent, borderColor: `${accent}66` }}
          >
            {DOCK_FLOW_LABEL[dock.flow]}
          </span>
        </div>

        <p className="mt-1.5 text-[10.5px] leading-snug text-ink-200">{dock.headline}</p>

        <div className="mt-1.5">
          <Bar value={dock.progress} color={accent} />
        </div>

        <div className="mt-1.5 grid grid-cols-3 gap-1.5 text-center">
          {summaryOf(dock).map((cell) => (
            <div key={cell.label} className="rounded-md border border-ink-700/70 bg-ink-850/50 py-1">
              <div
                className={cx(
                  'font-mono text-[11px] font-semibold leading-none tabular-nums',
                  cell.warn ? 'text-[var(--viz-warning)]' : 'text-ink-100',
                )}
              >
                {cell.value}
              </div>
              <div className="mt-0.5 text-[8px] uppercase tracking-wider text-ink-400">
                {cell.label}
              </div>
            </div>
          ))}
        </div>

        <p className="mt-1.5 text-[9px] text-ink-500">Click the door for the full picture.</p>
      </div>
    </div>
  )
}

/** Three numbers, chosen by which way the door is working. */
function summaryOf(dock: DockActivity): { label: string; value: string; warn?: boolean }[] {
  if (dock.flow === 'inbound' && dock.inbound) {
    return [
      { label: 'Lines', value: `${dock.inbound.linesCounted}/${dock.inbound.lines}` },
      { label: 'Counted', value: String(dock.inbound.unitsCounted) },
      { label: 'To store', value: String(dock.inbound.unitsToPutAway), warn: dock.inbound.unitsToPutAway > 0 },
    ]
  }
  return [
    { label: 'On belt', value: String(dock.outbound.enRoute) },
    { label: 'Staged', value: String(dock.outbound.staged), warn: dock.outbound.full },
    {
      label: dock.outbound.staged > 0 ? 'Seals in' : 'Shipped',
      value:
        dock.outbound.staged > 0
          ? dock.outbound.full
            ? 'now'
            : shortDuration(dock.outbound.sealIn ?? 0)
          : String(dock.outbound.dispatched),
    },
  ]
}
