import { useEffect, useRef } from 'react'
import { PutawayWalker } from '../inbound/walker'
import { WarehouseScene } from '../scene/WarehouseScene'
import { useAppStore } from '../store/useAppStore'
import { Inspector } from './Inspector'

/** Pushing a loaded pallet is slower than walking a pick round. */
const PUTAWAY_PACE = 0.78

/**
 * Hosts the WebGL canvas and owns the single animation frame loop.
 *
 * Order per frame: advance the simulation -> push agent state into the scene ->
 * render. React state is only touched by the throttled metrics publisher, so a
 * heavy dashboard re-render can never stutter the 3D view.
 */
export function SceneView() {
  const containerRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<WarehouseScene | null>(null)

  const model = useAppStore((s) => s.model)
  const status = useAppStore((s) => s.status)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const scene = new WarehouseScene(
      container,
      {
        onSelect: (selection) => useAppStore.getState().setSelection(selection),
        onHoverChange: () => {},
      },
      useAppStore.getState().theme,
    )
    sceneRef.current = scene

    // Dev-only handle for poking at the twin from the console / a test driver.
    if (import.meta.env.DEV) {
      ;(window as unknown as Record<string, unknown>).__pickTwin = { scene, store: useAppStore }
    }

    let raf = 0
    let last = performance.now()
    let metricsAccumulator = 0
    /**
     * The putaway operator lives outside the engine on purpose: inbound work is
     * commissioned by hand and has to run on a paused twin too. It is ticked
     * here so it shares the render clock with everything else on the floor.
     */
    let walker: PutawayWalker | null = null
    let walkerBinId: string | null = null

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      const dt = Math.min((now - last) / 1000, 0.25)
      last = now

      const state = useAppStore.getState()

      const run = state.placementRun
      if (run && !walker) {
        walkerBinId = run.plan.chosenBinId
        walker = new PutawayWalker(run.plan.route, {
          speed: state.settings.pickerSpeed * PUTAWAY_PACE,
          // Long enough to read as work being done, short enough not to stall.
          handleSec: 6,
          onArrive: () => useAppStore.getState().completePlacement(),
          onFinish: () => useAppStore.getState().endPlacementRun(),
        })
      } else if (!run && walker) {
        walker = null
        walkerBinId = null
      }

      if (walker) {
        walker.advance(dt * state.timeScale)
        scene.syncPutawayWalker(walker.state, dt, walkerBinId ?? undefined)
      } else {
        scene.syncPutawayWalker(null, dt)
      }

      const engine = state.engine
      if (engine) {
        engine.advance(dt, state.timeScale)
        scene.frame(dt, engine.agents, {
          parcels: engine.parcels,
          stations: engine.packStations,
          speed: state.settings.conveyorSpeed,
        })

      } else {
        scene.frame(dt, [])
      }

      // Publish at ~8 Hz; enough for a live dashboard, cheap for React. The
      // walker rides the same tick so the progress bar never drives a re-render
      // per frame.
      metricsAccumulator += dt
      if (metricsAccumulator >= 0.125) {
        metricsAccumulator = 0
        if (engine) state.publishMetrics()
        if (walker) state.publishWalker(walker.state)
      }
    }
    raf = requestAnimationFrame(loop)

    // Keep the scene in sync with UI-owned view options.
    const unsubscribe = useAppStore.subscribe((s, prev) => {
      if (s.model !== prev.model && s.model) scene.setModel(s.model)
      if (
        s.showPaths !== prev.showPaths ||
        s.showSequence !== prev.showSequence ||
        s.showParcels !== prev.showParcels ||
        s.binColorMode !== prev.binColorMode ||
        s.focusAgentId !== prev.focusAgentId
      ) {
        scene.setOptions({
          showPaths: s.showPaths,
          showSequence: s.showSequence,
          showParcels: s.showParcels,
          binColorMode: s.binColorMode,
          focusAgentId: s.focusAgentId,
        })
      }
      if (s.theme !== prev.theme) scene.setTheme(s.theme)
      // On-hand levels moved facility-wide (a shift reset restoring opening
      // stock, a putaway landing). Locations are drawn at the height of what is
      // in them, so the racking has to be re-read.
      if (s.stockVersion !== prev.stockVersion) scene.refreshStockLevels()
      if (s.selection !== prev.selection) scene.setSelection(s.selection)
      if (s.cameraPreset !== prev.cameraPreset) scene.applyPreset(s.cameraPreset)

      // Inbound roadmap: draw the walk to the free location and fly to it, so
      // the plan on the left is the thing you are looking at in the scene.
      if (s.putawayPlan !== prev.putawayPlan) {
        const plan = s.putawayPlan
        scene.setPutawayRoute(
          plan?.route ?? null,
          plan?.candidates.map((c) => ({ binId: c.binId, chosen: c.binId === plan.chosenBinId })) ??
            [],
        )
        if (plan && plan.chosenBinId !== prev.putawayPlan?.chosenBinId) {
          scene.setSelection({ kind: 'bin', id: plan.chosenBinId })
          scene.frameRoute(plan.route)
        }
      }

      // A confirmed putaway physically changes a shelf, so the scene has to be
      // told — the bin palettes are baked and would otherwise show the old SKU.
      if (s.lastPlacement !== prev.lastPlacement) {
        if (s.lastPlacement) scene.markPlaced(s.lastPlacement.binId)
        else if (!s.putawayPlan) scene.setPutawayRoute(null)
      }
      if (s.leftOpen !== prev.leftOpen || s.rightOpen !== prev.rightOpen) {
        // Panel transition is 300ms; resize once it has settled.
        window.setTimeout(() => {
          scene.resize()
          scene.applyPreset(scene.activePreset)
        }, 320)
      }
    })

    const initial = useAppStore.getState()
    if (initial.model) scene.setModel(initial.model)
    scene.setOptions({
      showPaths: initial.showPaths,
      showSequence: initial.showSequence,
      showParcels: initial.showParcels,
      binColorMode: initial.binColorMode,
      focusAgentId: initial.focusAgentId,
    })

    return () => {
      cancelAnimationFrame(raf)
      unsubscribe()
      scene.dispose()
      sceneRef.current = null
    }
  }, [])

  // A layout switch happens before the subscriber above can see it on mount.
  useEffect(() => {
    if (model && sceneRef.current) sceneRef.current.setModel(model)
  }, [model])

  return (
    <div ref={containerRef} className="relative h-full w-full">
      {status === 'loading' && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-ink-950">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-ink-700 border-t-accent" />
          <p className="text-xs text-ink-400">Generating warehouse & navigation graph…</p>
        </div>
      )}
      <Inspector sceneRef={sceneRef} />
    </div>
  )
}
