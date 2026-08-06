import { useMemo } from 'react'
import { dockActivityOf, type DockActivity } from '../simulation/dockActivity'
import { useAppStore } from '../store/useAppStore'

/**
 * Live state of every dock door.
 *
 * Derived, never stored: the inputs (the model, the published metrics and the
 * goods-in receipts) are already in the store, so caching a fourth copy of them
 * would only create something that could go stale. Memoised on those three, which
 * means it recomputes on the metrics tick and not per render.
 */
export function useDockActivity(): DockActivity[] {
  const model = useAppStore((s) => s.model)
  const metrics = useAppStore((s) => s.metrics)
  const receipts = useAppStore((s) => s.receipts)
  return useMemo(() => dockActivityOf(model, metrics, receipts), [model, metrics, receipts])
}

/** One door, by facility id. */
export function useDockState(id: string | null | undefined): DockActivity | null {
  const docks = useDockActivity()
  return id ? (docks.find((d) => d.id === id) ?? null) : null
}
