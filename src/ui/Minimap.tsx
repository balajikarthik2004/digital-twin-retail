import { useEffect, useRef } from 'react'
import { channelHex, sceneTheme, velocityHex } from '../scene/theme'
import { useAppStore } from '../store/useAppStore'
import { cx } from './components/primitives'
import { CloseIcon, CollapseIcon, ExpandIcon } from './components/icons'
import type { ThemeMode } from './theme'

/** `0xrrggbb` -> `#rrggbb`, so canvas 2D can use the scene's own palette. */
function hex(n: number): string {
  return `#${n.toString(16).padStart(6, '0')}`
}

/**
 * Top-down 2D plan view.
 *
 * Operators read plan view faster than perspective, so this is a real second
 * view of the same live data — racks tinted by velocity zone, planned paths,
 * walked paths, and every picker — not a screenshot of the 3D scene. It draws
 * on its own ~30 fps timer straight from the engine, independent of React.
 */
export function Minimap() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const open = useAppStore((s) => s.minimapOpen)
  const large = useAppStore((s) => s.minimapLarge)
  const toggle = useAppStore((s) => s.toggle)
  const theme = useAppStore((s) => s.theme)

  useEffect(() => {
    if (!open) return
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    let lastDraw = 0

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw)
      if (now - lastDraw < 33) return
      lastDraw = now

      const { model, engine, showPaths } = useAppStore.getState()
      if (!model) return
      const T = sceneTheme(theme)

      const dpr = Math.min(window.devicePixelRatio, 2)
      const w = wrap.clientWidth
      const h = wrap.clientHeight
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
      }

      const { bounds } = model
      const spanX = bounds.maxX - bounds.minX
      const spanZ = bounds.maxZ - bounds.minZ
      const pad = 8
      const scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanZ)
      const ox = (w - spanX * scale) / 2 - bounds.minX * scale
      const oy = (h - spanZ * scale) / 2 - bounds.minZ * scale
      const px = (x: number) => ox + x * scale
      const py = (z: number) => oy + z * scale

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)

      ctx.fillStyle = hex(T.floor)
      ctx.fillRect(0, 0, w, h)

      // Aisle + cross-aisle lanes.
      ctx.fillStyle = hex(T.aisleLane)
      for (const x of model.aisleX) {
        ctx.fillRect(
          px(x - model.config.aisleWidth / 2),
          py(model.crossZ[0]),
          model.config.aisleWidth * scale,
          (model.crossZ[model.crossZ.length - 1] - model.crossZ[0]) * scale,
        )
      }
      for (const z of model.crossZ) {
        ctx.fillRect(
          px(bounds.minX),
          py(z - model.config.crossAisleWidth / 2),
          spanX * scale,
          model.config.crossAisleWidth * scale,
        )
      }

      // Racks, tinted by the dominant velocity tier in the run.
      const tierByRack = rackTiers(model, theme)
      for (const rack of model.racks) {
        ctx.fillStyle = tierByRack.get(rack.id) ?? hex(T.rackDeck)
        ctx.globalAlpha = 0.72
        ctx.fillRect(px(rack.x0), py(rack.z0), (rack.x1 - rack.x0) * scale, (rack.z1 - rack.z0) * scale)
        ctx.globalAlpha = 1
        ctx.strokeStyle = T.floorGrid
        ctx.lineWidth = 0.6
        ctx.strokeRect(px(rack.x0), py(rack.z0), (rack.x1 - rack.x0) * scale, (rack.z1 - rack.z0) * scale)
      }

      // Facilities.
      for (const f of model.facilities) {
        ctx.fillStyle =
          f.kind === 'dock' ? hex(T.dockDoor) : f.kind === 'pack' ? hex(T.packTop) : hex(T.stagingEdge)
        if (f.kind === 'staging') ctx.globalAlpha = 0.25
        ctx.fillRect(
          px(f.pos.x - f.width / 2),
          py(f.pos.y - f.depth / 2),
          f.width * scale,
          Math.max(2, f.depth * scale),
        )
        ctx.globalAlpha = 1
      }

      // Conveyor loop: the takeaway trunk, its spurs and the dock chutes. Drawn
      // before the live layers so parcels and pickers sit on top of it.
      const conveyor = model.conveyor
      const stroke = (points: { x: number; z: number }[], width: number, color: string) => {
        if (points.length < 2) return
        ctx.strokeStyle = color
        ctx.lineWidth = width
        ctx.beginPath()
        points.forEach((p, i) => (i === 0 ? ctx.moveTo(px(p.x), py(p.z)) : ctx.lineTo(px(p.x), py(p.z))))
        ctx.stroke()
      }
      ctx.lineCap = 'round'
      stroke(conveyor.trunk.polyline, large ? 3.6 : 2.6, hex(T.conveyor.frame))
      for (const spur of conveyor.spurs) stroke(spur.polyline, large ? 2 : 1.5, hex(T.conveyor.frame))
      for (const chute of conveyor.chutes) {
        stroke(chute.polyline, large ? 1.8 : 1.4, T.conveyor.chute)
      }
      ctx.lineCap = 'butt'

      if (!engine) return

      // Parcels on the belt and stacked at the doors.
      const CHANNEL = channelHex(theme)
      for (const parcel of engine.parcels) {
        if (parcel.stage === 'dispatched') continue
        const size = large ? 3.4 : 2.4
        ctx.fillStyle = parcel.blocked ? hex(T.pack.beaconBlocked) : CHANNEL[parcel.channel]
        ctx.fillRect(px(parcel.pos.x) - size / 2, py(parcel.pos.z) - size / 2, size, size)
      }

      // Paths, then pickers on top.
      for (const agent of engine.agents) {
        if (!agent.route || agent.phase === 'idle' || !showPaths) continue
        const pts = agent.route.polyline

        // Still to walk: dashed, so "planned" reads as a different kind of
        // line from "done" instead of merely a fainter one.
        ctx.strokeStyle = agent.color
        ctx.lineWidth = 1
        ctx.globalAlpha = 0.45
        ctx.setLineDash([4, 3])
        ctx.beginPath()
        pts.forEach((p, i) => (i === 0 ? ctx.moveTo(px(p.x), py(p.y)) : ctx.lineTo(px(p.x), py(p.y))))
        ctx.stroke()
        ctx.setLineDash([])

        // Already walked: solid and bold.
        ctx.globalAlpha = 0.95
        ctx.lineWidth = 2
        ctx.beginPath()
        let started = false
        for (let i = 0; i < pts.length; i++) {
          if (agent.route.cumulative[i] > agent.arc) break
          const p = pts[i]
          if (!started) {
            ctx.moveTo(px(p.x), py(p.y))
            started = true
          } else ctx.lineTo(px(p.x), py(p.y))
        }
        ctx.lineTo(px(agent.pos.x), py(agent.pos.y))
        ctx.stroke()
        ctx.globalAlpha = 1

        // Remaining pick stops: the one the picker is walking to right now
        // stands out with a ring; the rest of the queue is a dim dot so it
        // doesn't compete with it. Mirrors the same three-tier hierarchy the
        // 3D bin tints use.
        for (const wp of agent.route.waypoints) {
          const bin = model.binsById.get(wp.stop.ref)
          if (!bin) continue
          const done = wp.sequence <= agent.nextWaypoint
          const current = wp.sequence === agent.nextWaypoint + 1
          const x = px(bin.face.x)
          const y = py(bin.face.z)
          const r = large ? 2.4 : 1.6

          if (current) {
            ctx.strokeStyle = agent.color
            ctx.lineWidth = 1.4
            ctx.globalAlpha = 0.9
            ctx.beginPath()
            ctx.arc(x, y, r + 2, 0, Math.PI * 2)
            ctx.stroke()
            ctx.globalAlpha = 1
          }
          ctx.fillStyle = done ? hex(T.binDone) : agent.color
          ctx.globalAlpha = done || current ? 1 : 0.5
          ctx.beginPath()
          ctx.arc(x, y, r, 0, Math.PI * 2)
          ctx.fill()
          ctx.globalAlpha = 1
        }
      }

      for (const agent of engine.agents) {
        const x = px(agent.pos.x)
        const y = py(agent.pos.y)
        ctx.fillStyle = agent.phase === 'blocked' ? hex(T.dockDoor) : agent.color
        ctx.beginPath()
        ctx.arc(x, y, large ? 4.5 : 3.2, 0, Math.PI * 2)
        ctx.fill()
        // Ring the dot in the floor colour so it reads on top of a path line.
        ctx.strokeStyle = hex(T.floor)
        ctx.lineWidth = 1.6
        ctx.stroke()
        if (large) {
          ctx.fillStyle = theme === 'light' ? '#1b2430' : '#e8eef6'
          ctx.font = '600 9px Inter, system-ui, sans-serif'
          ctx.fillText(agent.label, x + 6, y + 3)
        }
      }
    }

    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [open, large, theme])

  if (!open) {
    return (
      <button type="button" onClick={() => toggle('minimapOpen')} className="btn btn-primary">
        Show plan view
      </button>
    )
  }

  return (
    <div
      className={cx(
        'panel-float overflow-hidden transition-[width,height] duration-300 ease-out',
        large ? 'h-[360px] w-[420px]' : 'h-[200px] w-[240px]',
      )}
    >
      <header className="panel-header !py-1.5">
        <h3 className="panel-title">Plan view</h3>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => toggle('minimapLarge')}
            className="btn btn-icon"
            title={large ? 'Shrink plan view' : 'Enlarge plan view'}
            aria-label={large ? 'Shrink plan view' : 'Enlarge plan view'}
          >
            {large ? <CollapseIcon size={11} /> : <ExpandIcon size={11} />}
          </button>
          <button
            type="button"
            onClick={() => toggle('minimapOpen')}
            className="btn btn-icon"
            title="Hide plan view (m)"
            aria-label="Hide plan view"
          >
            <CloseIcon size={11} />
          </button>
        </div>
      </header>
      <div ref={wrapRef} className="relative h-[calc(100%-33px)] w-full">
        <canvas ref={canvasRef} className="block h-full w-full" />
      </div>
    </div>
  )
}

/** Colour each rack run by the velocity tier that dominates it. */
function rackTiers(model: ReturnType<typeof useAppStore.getState>['model'], theme: ThemeMode) {
  const out = new Map<string, string>()
  if (!model) return out
  const VELOCITY_HEX = velocityHex(theme)
  const counts = new Map<string, { fast: number; medium: number; slow: number }>()
  for (const bin of model.bins) {
    const key = `rack-a${bin.aisle}-${bin.side}-b${bin.block}`
    let entry = counts.get(key)
    if (!entry) {
      entry = { fast: 0, medium: 0, slow: 0 }
      counts.set(key, entry)
    }
    entry[bin.sku.velocity]++
  }
  for (const [key, entry] of counts) {
    const top = (Object.entries(entry) as [keyof typeof entry, number][]).sort((a, b) => b[1] - a[1])[0][0]
    out.set(key, VELOCITY_HEX[top])
  }
  return out
}
