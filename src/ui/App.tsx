import { useEffect } from 'react'
import { useAppStore } from '../store/useAppStore'
import { ControlPanel } from './ControlPanel'
import { MetricsPanel } from './MetricsPanel'
import { Minimap } from './Minimap'
import { SceneView } from './SceneView'
import { Toasts } from './Toasts'
import { TopBar } from './TopBar'
import { ViewControls } from './ViewControls'
import { cx } from './components/primitives'
import { applyTheme } from './theme'

export function App() {
  const boot = useAppStore((s) => s.boot)
  const status = useAppStore((s) => s.status)
  const error = useAppStore((s) => s.error)
  const leftOpen = useAppStore((s) => s.leftOpen)
  const rightOpen = useAppStore((s) => s.rightOpen)
  const toggle = useAppStore((s) => s.toggle)
  const theme = useAppStore((s) => s.theme)

  useEffect(() => {
    void boot()
  }, [boot])

  // Keep the document in sync so the CSS token set matches the store on load.
  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  // Keyboard shortcuts a demo operator will reach for.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const state = useAppStore.getState()
      if (e.code === 'Space') {
        e.preventDefault()
        state.metrics?.running ? state.pause() : state.start()
      } else if (e.key === '[') toggle('leftOpen')
      else if (e.key === ']') toggle('rightOpen')
      else if (e.key === 'm') toggle('minimapOpen')
      else if (e.key === 't') state.setTheme(state.theme === 'light' ? 'dark' : 'light')
      else if (e.key === '1') state.setCameraPreset('overview')
      else if (e.key === '2') state.setCameraPreset('top')
      else if (e.key === '3') state.setCameraPreset('aisle')
      else if (e.key === '4') state.setCameraPreset('dock')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggle])

  if (status === 'error') {
    return (
      <div className="grid h-full place-items-center bg-ink-950 p-8">
        <div className="panel max-w-md p-6 text-center">
          <div className="text-lg font-semibold text-[var(--viz-critical)]">Failed to initialise</div>
          <p className="mt-2 text-xs leading-relaxed text-ink-300">{error}</p>
          <button type="button" onClick={() => void boot()} className="btn btn-primary mt-4">
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-ink-950">
      <TopBar />

      <div className="relative flex min-h-0 flex-1">
        {/* Left: warehouse & simulation controls */}
        <aside
          className={cx(
            'relative z-20 shrink-0 overflow-hidden border-r border-ink-700 bg-ink-950 transition-[width] duration-300 ease-out',
            leftOpen ? 'w-[306px]' : 'w-0',
          )}
        >
          <div className="h-full w-[306px]">
            <ControlPanel />
          </div>
        </aside>

        {/* Centre: 3D viewport with floating overlays */}
        <main className="relative min-w-0 flex-1">
          <SceneView />

          <div className="pointer-events-none absolute inset-0">
            <div className="pointer-events-auto absolute bottom-4 left-4">
              <ViewControls />
            </div>
            <div className="pointer-events-auto absolute bottom-4 right-4">
              <Minimap />
            </div>
          </div>

          <Toasts />
        </main>

        {/* Right: live metrics & comparison */}
        <aside
          className={cx(
            'relative z-20 shrink-0 overflow-hidden border-l border-ink-700 bg-ink-950 transition-[width] duration-300 ease-out',
            rightOpen ? 'w-[340px]' : 'w-0',
          )}
        >
          <div className="h-full w-[340px]">
            <MetricsPanel />
          </div>
        </aside>
      </div>
    </div>
  )
}
