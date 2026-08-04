import { useEffect, useRef } from 'react'
import { WarehouseScene } from '../scene/WarehouseScene'
import { useAppStore } from '../store/useAppStore'
import { Inspector } from './Inspector'

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

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      const dt = Math.min((now - last) / 1000, 0.25)
      last = now

      const state = useAppStore.getState()
      const engine = state.engine
      if (engine) {
        engine.advance(dt, state.timeScale)
        scene.frame(dt, engine.agents)

        // Publish metrics at ~8 Hz; enough for a live dashboard, cheap for React.
        metricsAccumulator += dt
        if (metricsAccumulator >= 0.125) {
          metricsAccumulator = 0
          state.publishMetrics()
        }
      } else {
        scene.frame(dt, [])
      }
    }
    raf = requestAnimationFrame(loop)

    // Keep the scene in sync with UI-owned view options.
    const unsubscribe = useAppStore.subscribe((s, prev) => {
      if (s.model !== prev.model && s.model) scene.setModel(s.model)
      if (
        s.showPaths !== prev.showPaths ||
        s.showSequence !== prev.showSequence ||
        s.binColorMode !== prev.binColorMode ||
        s.focusAgentId !== prev.focusAgentId
      ) {
        scene.setOptions({
          showPaths: s.showPaths,
          showSequence: s.showSequence,
          binColorMode: s.binColorMode,
          focusAgentId: s.focusAgentId,
        })
      }
      if (s.theme !== prev.theme) scene.setTheme(s.theme)
      if (s.selection !== prev.selection) scene.setSelection(s.selection)
      if (s.cameraPreset !== prev.cameraPreset) scene.applyPreset(s.cameraPreset)
      if (s.leftOpen !== prev.leftOpen || s.rightOpen !== prev.rightOpen) {
        // Panel transition is 300ms; resize once it has settled.
        window.setTimeout(() => scene.resize(), 320)
      }
    })

    const initial = useAppStore.getState()
    if (initial.model) scene.setModel(initial.model)
    scene.setOptions({
      showPaths: initial.showPaths,
      showSequence: initial.showSequence,
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
