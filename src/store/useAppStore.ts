import { create } from 'zustand'
import { activeSource } from '../data'
import { DEFAULT_STRATEGY_ID } from '../pathfinding/strategies'
import { compareStrategies } from '../simulation/compare'
import { SimulationEngine, clampAgents } from '../simulation/engine'
import {
  generateOrders,
  importOrders,
  resetOrderSequence,
  type OrderGenOptions,
} from '../simulation/orderGenerator'
import type { Order, SimMetrics, SimSettings, StrategyComparison } from '../simulation/types'
import type { BinColorMode } from '../scene/buildWarehouse'
import type { CameraPresetId } from '../scene/cameraPresets'
import type { SceneSelection } from '../scene/WarehouseScene'
import { AGENT_PALETTES, applyTheme, initialTheme, type ThemeMode } from '../ui/theme'
import { generateWarehouse } from '../warehouse/generate'
import type { WarehouseConfig, WarehouseModel } from '../warehouse/types'

export type TimeScale = 1 | 5 | 20

export interface Toast {
  id: number
  tone: 'info' | 'success' | 'warn' | 'error'
  message: string
  detail?: string
}

const DEFAULT_ORDER_GEN: OrderGenOptions = {
  count: 24,
  minLines: 3,
  maxLines: 9,
  arrivalPerMin: 6,
  seed: 424242,
}

interface AppState {
  status: 'loading' | 'ready' | 'error'
  error: string | null

  layouts: WarehouseConfig[]
  layoutId: string
  model: WarehouseModel | null
  engine: SimulationEngine | null

  settings: SimSettings
  timeScale: TimeScale
  metrics: SimMetrics | null
  orders: Order[]
  orderGen: OrderGenOptions

  comparison: StrategyComparison[] | null
  comparing: boolean

  // UI
  theme: ThemeMode
  leftOpen: boolean
  rightOpen: boolean
  minimapOpen: boolean
  minimapLarge: boolean
  showPaths: boolean
  showSequence: boolean
  binColorMode: BinColorMode
  cameraPreset: CameraPresetId
  selection: SceneSelection
  focusAgentId: string | null
  toast: Toast | null

  // Actions
  boot(): Promise<void>
  selectLayout(id: string): void
  updateSettings(patch: Partial<SimSettings>): void
  setTimeScale(scale: TimeScale): void
  start(): void
  pause(): void
  reset(): void
  publishMetrics(): void

  setOrderGen(patch: Partial<OrderGenOptions>): void
  regenerateOrders(): void
  loadSampleOrders(): Promise<void>
  importOrdersJson(text: string): void
  clearOrders(): void

  runComparison(): void
  clearComparison(): void

  setSelection(selection: SceneSelection): void
  setCameraPreset(preset: CameraPresetId): void
  setTheme(mode: ThemeMode): void
  toggle(key: 'leftOpen' | 'rightOpen' | 'minimapOpen' | 'minimapLarge' | 'showPaths' | 'showSequence'): void
  setBinColorMode(mode: BinColorMode): void
  setFocusAgent(id: string | null): void
  notify(toast: Omit<Toast, 'id'>): void
  dismissToast(): void
}

function settingsFor(config: WarehouseConfig, previous?: SimSettings): SimSettings {
  return {
    agentCount: previous?.agentCount ?? 4,
    strategyId: previous?.strategyId ?? DEFAULT_STRATEGY_ID,
    pickerKind: previous?.pickerKind ?? 'cart',
    pickerSpeed: config.pickerSpeed,
    pickTimeSec: config.pickTimeSec,
    perUnitTimeSec: config.perUnitTimeSec,
    unloadTimeSec: 25,
    congestionRadius: Math.max(1.6, config.aisleWidth * 0.72),
    smartDispatch: previous?.smartDispatch ?? true,
    batchOrders: previous?.batchOrders ?? true,
    rerouting: previous?.rerouting ?? true,
    restBreaks: previous?.restBreaks ?? true,
    stockDepletion: previous?.stockDepletion ?? true,
  }
}

let toastSeq = 1

export const useAppStore = create<AppState>((set, get) => ({
  status: 'loading',
  error: null,

  layouts: [],
  layoutId: '',
  model: null,
  engine: null,

  settings: {
    agentCount: 4,
    strategyId: DEFAULT_STRATEGY_ID,
    pickerKind: 'cart',
    pickerSpeed: 1.3,
    pickTimeSec: 12,
    perUnitTimeSec: 2.5,
    unloadTimeSec: 25,
    congestionRadius: 2.2,
    smartDispatch: true,
    batchOrders: true,
    rerouting: true,
    restBreaks: true,
    stockDepletion: true,
  },
  timeScale: 5,
  metrics: null,
  orders: [],
  orderGen: { ...DEFAULT_ORDER_GEN },

  comparison: null,
  comparing: false,

  theme: initialTheme(),
  leftOpen: true,
  rightOpen: true,
  minimapOpen: true,
  minimapLarge: false,
  showPaths: true,
  showSequence: true,
  binColorMode: 'velocity',
  cameraPreset: 'overview',
  selection: null,
  focusAgentId: null,
  toast: null,

  async boot() {
    try {
      const layouts = await activeSource.listLayouts()
      const defaultId = await activeSource.defaultLayoutId()
      const config = layouts.find((l) => l.id === defaultId) ?? layouts[0]
      if (!config) throw new Error('No warehouse layouts available from the data source.')

      set({ layouts, layoutId: config.id })
      const model = generateWarehouse(config)
      const settings = settingsFor(config)
      const engine = new SimulationEngine(model, settings)
      engine.setAgentPalette(AGENT_PALETTES[get().theme])

      resetOrderSequence()
      let orders = await activeSource.loadOrders(model)
      if (orders.length === 0) {
        orders = generateOrders(model, { ...get().orderGen })
      }
      engine.setOrders(orders)

      set({
        status: 'ready',
        model,
        engine,
        settings,
        orders,
        metrics: engine.metrics(),
        comparison: null,
      })
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  },

  selectLayout(id) {
    const { layouts, settings: prev, orderGen } = get()
    const config = layouts.find((l) => l.id === id)
    if (!config) return

    const model = generateWarehouse(config)
    const settings = settingsFor(config, prev)
    const engine = new SimulationEngine(model, settings)
    engine.setAgentPalette(AGENT_PALETTES[get().theme])

    resetOrderSequence()
    // Hand-written sample orders only resolve against the layout they were
    // written for, so any other layout gets freshly generated demand.
    const orders = generateOrders(model, { ...orderGen })
    engine.setOrders(orders)

    set({
      layoutId: id,
      model,
      engine,
      settings,
      orders,
      metrics: engine.metrics(),
      selection: null,
      focusAgentId: null,
      comparison: null,
    })
    get().notify({ tone: 'info', message: `Loaded ${config.name}`, detail: `${model.bins.length.toLocaleString()} storage locations · ${orders.length} generated orders` })
  },

  updateSettings(patch) {
    const engine = get().engine
    const next = { ...get().settings, ...patch }
    if (patch.agentCount !== undefined) next.agentCount = clampAgents(patch.agentCount)
    engine?.updateSettings(next)
    // Comparison figures depend on pick times / speed, so invalidate them when
    // those change (but not when only the live strategy is switched).
    const invalidates =
      patch.pickerSpeed !== undefined ||
      patch.pickTimeSec !== undefined ||
      patch.perUnitTimeSec !== undefined ||
      patch.unloadTimeSec !== undefined
    set({ settings: next, comparison: invalidates ? null : get().comparison })
  },

  setTimeScale(scale) {
    set({ timeScale: scale })
  },

  start() {
    const { engine } = get()
    if (!engine) return
    if (engine.getOrders().length === 0) {
      get().notify({ tone: 'warn', message: 'No orders queued', detail: 'Generate a batch or import a wave first.' })
      return
    }
    engine.start()
    set({ metrics: engine.metrics() })
  },

  pause() {
    const { engine } = get()
    engine?.pause()
    set({ metrics: engine?.metrics() ?? null })
  },

  reset() {
    const { engine } = get()
    if (!engine) return
    engine.reset({ keepOrders: true })
    set({ metrics: engine.metrics(), selection: null })
  },

  publishMetrics() {
    const engine = get().engine
    if (engine) set({ metrics: engine.metrics() })
  },

  setOrderGen(patch) {
    set({ orderGen: { ...get().orderGen, ...patch } })
  },

  regenerateOrders() {
    const { engine, model, orderGen } = get()
    if (!engine || !model) return
    resetOrderSequence()
    const orders = generateOrders(model, { ...orderGen, seed: Math.floor(Math.random() * 1e9) })
    engine.setOrders(orders)
    set({ orders, metrics: engine.metrics(), comparison: null, selection: null })
    get().notify({
      tone: 'success',
      message: `Generated ${orders.length} orders`,
      detail: `${orders.reduce((s, o) => s + o.lines.length, 0)} pick lines · ${orderGen.arrivalPerMin}/min arrival`,
    })
  },

  async loadSampleOrders() {
    const { engine, model } = get()
    if (!engine || !model) return
    resetOrderSequence()
    const orders = await activeSource.loadOrders(model)
    if (orders.length === 0) {
      get().notify({
        tone: 'warn',
        message: 'Sample wave does not fit this layout',
        detail: 'Generate a batch instead, or switch back to DC North.',
      })
      return
    }
    engine.setOrders(orders)
    set({ orders, metrics: engine.metrics(), comparison: null, selection: null })
    get().notify({ tone: 'success', message: `Loaded sample wave · ${orders.length} orders` })
  },

  importOrdersJson(text) {
    const { engine, model } = get()
    if (!engine || !model) return
    try {
      const parsed = JSON.parse(text)
      const { orders, warnings } = importOrders(model, parsed)
      engine.setOrders(orders)
      set({ orders, metrics: engine.metrics(), comparison: null, selection: null })
      get().notify({
        tone: warnings.length > 0 ? 'warn' : 'success',
        message: `Imported ${orders.length} orders`,
        detail: warnings.length > 0 ? `${warnings.length} issue(s): ${warnings[0]}` : undefined,
      })
    } catch (err) {
      get().notify({
        tone: 'error',
        message: 'Import failed',
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  },

  clearOrders() {
    const { engine } = get()
    if (!engine) return
    engine.setOrders([])
    set({ orders: [], metrics: engine.metrics(), comparison: null, selection: null })
  },

  runComparison() {
    const { engine, model, orders, settings } = get()
    if (!engine || !model || orders.length === 0) {
      get().notify({ tone: 'warn', message: 'Nothing to compare', detail: 'Queue some orders first.' })
      return
    }
    set({ comparing: true })
    // Yield a frame so the button can show its pending state before the
    // (synchronous, CPU-bound) routing sweep runs.
    setTimeout(() => {
      try {
        const comparison = compareStrategies(model, engine.routingContext, orders, settings)
        set({ comparison, comparing: false })
      } catch (err) {
        set({ comparing: false })
        get().notify({
          tone: 'error',
          message: 'Comparison failed',
          detail: err instanceof Error ? err.message : String(err),
        })
      }
    }, 30)
  },

  clearComparison() {
    set({ comparison: null })
  },

  setSelection(selection) {
    set({ selection })
    if (selection?.kind === 'agent') set({ focusAgentId: selection.id })
  },

  setCameraPreset(preset) {
    set({ cameraPreset: preset })
  },

  setTheme(mode) {
    if (mode === get().theme) return
    applyTheme(mode)
    // Picker identity colours are part of the palette, so they swap too; the
    // scene rebuilds its meshes when it sees a colour change.
    get().engine?.setAgentPalette(AGENT_PALETTES[mode])
    set({ theme: mode, metrics: get().engine?.metrics() ?? get().metrics })
  },

  toggle(key) {
    set({ [key]: !get()[key] } as Partial<AppState>)
  },

  setBinColorMode(mode) {
    set({ binColorMode: mode })
  },

  setFocusAgent(id) {
    set({ focusAgentId: id })
  },

  notify(toast) {
    set({ toast: { ...toast, id: toastSeq++ } })
  },

  dismissToast() {
    set({ toast: null })
  },
}))
