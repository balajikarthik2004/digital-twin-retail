import { useEffect } from 'react'
import { useAppStore } from '../store/useAppStore'
import { cx } from './components/primitives'

const TONE: Record<string, string> = {
  info: 'border-ink-600',
  success: 'border-[var(--viz-good)]',
  warn: 'border-[var(--viz-warning)]',
  error: 'border-[var(--viz-critical)]',
}

const ICON: Record<string, string> = { info: 'ℹ', success: '✓', warn: '!', error: '✕' }

export function Toasts() {
  const toast = useAppStore((s) => s.toast)
  const dismiss = useAppStore((s) => s.dismissToast)

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(dismiss, toast.tone === 'error' ? 7000 : 4200)
    return () => window.clearTimeout(timer)
  }, [toast, dismiss])

  if (!toast) return null

  return (
    <div className="pointer-events-none absolute bottom-4 left-1/2 z-40 -translate-x-1/2">
      <div
        className={cx(
          'panel-float pointer-events-auto flex max-w-[420px] animate-fade-in items-start gap-2.5 border-l-[3px] px-3.5 py-2.5 text-ink-100',
          TONE[toast.tone],
        )}
        role="status"
      >
        <span className="mt-px text-xs font-bold opacity-80">{ICON[toast.tone]}</span>
        <div className="min-w-0">
          <div className="text-[11.5px] font-semibold">{toast.message}</div>
          {toast.detail && <div className="mt-0.5 text-[10px] leading-snug text-ink-300">{toast.detail}</div>}
        </div>
        <button type="button" onClick={dismiss} className="ml-1 text-[10px] text-ink-400 hover:text-ink-100">
          ✕
        </button>
      </div>
    </div>
  )
}
