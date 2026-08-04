export function metres(v: number): string {
  if (v >= 10000) return `${(v / 1000).toFixed(1)} km`
  return `${Math.round(v).toLocaleString()} m`
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export function mmss(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

export function hoursMin(seconds: number): string {
  const m = Math.round(seconds / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export function pct(v: number, digits = 0): string {
  return `${(v * 100).toFixed(digits)}%`
}

export function compact(v: number): string {
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}k`
  return v.toFixed(0)
}

export const PHASE_LABEL: Record<string, string> = {
  idle: 'Idle',
  traveling: 'Travelling',
  picking: 'Picking',
  returning: 'Returning',
  unloading: 'At pack',
  blocked: 'Waiting',
  break: 'On break',
}

export const PHASE_TONE: Record<string, string> = {
  idle: 'text-ink-400',
  traveling: 'text-[var(--viz-series-1)]',
  picking: 'text-[var(--viz-warning)]',
  returning: 'text-[var(--viz-series-3)]',
  unloading: 'text-[var(--viz-series-3)]',
  blocked: 'text-[var(--viz-critical)]',
  break: 'text-ink-300',
}
