import { create } from 'zustand'
import { activeSource } from '../data'
import { applyPutaway, planPutaway } from '../inbound/plan'
import {
  createManualReceipt,
  generateReceipts,
  resetReceiptSequence,
  type ManualReceiptInput,
} from '../inbound/receipts'
import type { Movement, Placement, PutawayPlan, Receipt } from '../inbound/types'
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

/**
 * Left-sidebar workspace. The four sections follow the physical flow of goods
 * through the building: set the shift up, take stock in, send orders out, then
 * look back at what happened.
 */
export type AppSection = 'ops' | 'inbound' | 'outbound' | 'history'

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

  // ── inbound (goods-in & putaway) ────────────────────────────────────────────
  receipts: Receipt[]
  /** Receipt line currently being planned, if any. */
  activeLine: { receiptId: string; lineId: string } | null
  putawayPlan: PutawayPlan | null
  /**
   * The last confirmed putaway. Drives the final step of the inbound flow, and
   * is what tells the 3D scene which shelf just changed hands.
   */
  lastPlacement: Placement | null
  /** Confirmed putaways, newest last. Merged with shipped orders in History. */
  inboundLog: Movement[]
  /**
   * Bumped whenever on-hand levels change outside the simulation loop, so the
   * free-space views can memoise instead of re-summing every location per frame.
   */
  stockVersion: number

  // UI
  section: AppSection
  theme: ThemeMode
  leftOpen: boolean
  rightOpen: boolean
  minimapOpen: boolean
  minimapLarge: boolean
  showPaths: boolean
  showSequence: boolean
  /** Render parcels + conveyor motion in the 3D scene. */
  showParcels: boolean
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

  regenerateReceipts(): void
  bookInProduct(input: Omit<ManualReceiptInput, 'at'>): void
  planLine(receiptId: string, lineId: string): void
  chooseLocation(binId: string): void
  confirmPutaway(): void
  cancelPutaway(): void
  dismissPlacement(): void
  clearReceipts(): void

  setSection(section: AppSection): void
  setSelection(selection: SceneSelection): void
  setCameraPreset(preset: CameraPresetId): void
  setTheme(mode: ThemeMode): void
  toggle(
    key:
      | 'leftOpen'
      | 'rightOpen'
      | 'minimapOpen'
      | 'minimapLarge'
      | 'showPaths'
      | 'showSequence'
      | 'showParcels',
  ): void
  setBinColorMode(mode: BinColorMode): void
  setFocusAgent(id: string | null): void
  notify(toast: Omit<Toast, 'id'>): void
  dismissToast(): void
}

/** Pack-out defaults, shared by the initial state and every layout switch. */
export const DEFAULT_PACK_SETTINGS = {
  packSetupSec: 22,
  packPerLineSec: 5.5,
  packPerUnitSec: 0.9,
  unitsPerCarton: 14,
  conveyorSpeed: 0.85,
  conveyorSortation: true,
  packBufferLimit: 10,
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
    // Bench count is a property of the building, so staffing re-fits on a switch
    // rather than carrying a number the new layout cannot man.
    packStaff: Math.min(previous?.packStaff ?? config.packStations, config.packStations),
    packSetupSec: previous?.packSetupSec ?? DEFAULT_PACK_SETTINGS.packSetupSec,
    packPerLineSec: previous?.packPerLineSec ?? DEFAULT_PACK_SETTINGS.packPerLineSec,
    packPerUnitSec: previous?.packPerUnitSec ?? DEFAULT_PACK_SETTINGS.packPerUnitSec,
    unitsPerCarton: previous?.unitsPerCarton ?? DEFAULT_PACK_SETTINGS.unitsPerCarton,
    conveyorSpeed: previous?.conveyorSpeed ?? DEFAULT_PACK_SETTINGS.conveyorSpeed,
    conveyorSortation: previous?.conveyorSortation ?? DEFAULT_PACK_SETTINGS.conveyorSortation,
    packBufferLimit: previous?.packBufferLimit ?? DEFAULT_PACK_SETTINGS.packBufferLimit,
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
    packStaff: 3,
    ...DEFAULT_PACK_SETTINGS,
  },
  timeScale: 5,
  metrics: null,
  orders: [],
  orderGen: { ...DEFAULT_ORDER_GEN },

  comparison: null,
  comparing: false,

  receipts: [],
  activeLine: null,
  putawayPlan: null,
  lastPlacement: null,
  inboundLog: [],
  stockVersion: 0,

  section: 'ops',
  theme: initialTheme(),
  leftOpen: true,
  rightOpen: true,
  minimapOpen: true,
  minimapLarge: false,
  showPaths: true,
  showSequence: true,
  showParcels: true,
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

      resetReceiptSequence()
      const receipts = generateReceipts(model, { count: 8, seed: config.seed })

      set({
        status: 'ready',
        model,
        engine,
        settings,
        orders,
        receipts,
        activeLine: null,
        putawayPlan: null,
        lastPlacement: null,
        inboundLog: [],
        stockVersion: get().stockVersion + 1,
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

    resetReceiptSequence()
    const receipts = generateReceipts(model, { count: 8, seed: config.seed })

    set({
      layoutId: id,
      model,
      engine,
      settings,
      orders,
      receipts,
      activeLine: null,
      putawayPlan: null,
      lastPlacement: null,
      inboundLog: [],
      stockVersion: get().stockVersion + 1,
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
    if (patch.packStaff !== undefined) {
      // A bench that does not exist in this building cannot be staffed.
      const benches = get().model?.config.packStations ?? 1
      next.packStaff = Math.max(1, Math.min(benches, Math.round(patch.packStaff)))
    }
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
    // Received goods survive a shift reset (they are physically on the shelf),
    // but on-hand levels moved, so anything memoising them has to recompute.
    set({ metrics: engine.metrics(), selection: null, stockVersion: get().stockVersion + 1 })
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

  // ── inbound ─────────────────────────────────────────────────────────────────

  regenerateReceipts() {
    const { model } = get()
    if (!model) return
    resetReceiptSequence()
    const receipts = generateReceipts(model, {
      count: 8,
      seed: Math.floor(Math.random() * 1e9),
      startAt: get().metrics?.time ?? 0,
    })
    set({ receipts, activeLine: null, putawayPlan: null })
    get().notify({
      tone: 'success',
      message: `${receipts.length} trailers booked in`,
      detail: `${receipts.reduce((s, r) => s + r.lines.length, 0)} lines waiting for a location`,
    })
  },

  bookInProduct(input) {
    const { model } = get()
    if (!model) return
    const receipt = createManualReceipt({ ...input, at: get().metrics?.time ?? 0 })
    // Newest at the top: a line booked in at the door is the one being worked.
    set({ receipts: [receipt, ...get().receipts], lastPlacement: null })
    get().planLine(receipt.id, receipt.lines[0].id)
  },

  planLine(receiptId, lineId) {
    const { model, engine } = get()
    if (!model || !engine) return
    const receipt = get().receipts.find((r) => r.id === receiptId)
    const line = receipt?.lines.find((l) => l.id === lineId)
    if (!receipt || !line) return

    if (line.status === 'stored') {
      // Nothing to decide — just show where it went.
      set({ selection: line.storedBinId ? { kind: 'bin', id: line.storedBinId } : null })
      get().notify({
        tone: 'info',
        message: `${line.name} is already stored`,
        detail: `${line.storedQty} units at ${line.storedCode}`,
      })
      return
    }

    const plan = planPutaway(model, engine.routingContext, receipt, line, {
      speed: get().settings.pickerSpeed,
    })
    // Planning a line always leaves the "placed" step — this is a new decision.
    set({ activeLine: { receiptId, lineId }, putawayPlan: plan, lastPlacement: null })

    if (!plan) {
      get().notify({
        tone: 'warn',
        message: 'No legal location for this line',
        detail:
          line.skuId === null
            ? 'Every location is occupied — clear one before re-slotting a new line.'
            : 'Its home location is full and there are no empty locations left.',
      })
      return
    }
    // Framing the target in 3D is the whole point of the roadmap.
    set({ selection: { kind: 'bin', id: plan.chosenBinId } })
  },

  chooseLocation(binId) {
    const { model, engine, putawayPlan } = get()
    if (!model || !engine || !putawayPlan) return
    const receipt = get().receipts.find((r) => r.id === putawayPlan.receiptId)
    const line = receipt?.lines.find((l) => l.id === putawayPlan.lineId)
    if (!receipt || !line) return

    const plan = planPutaway(model, engine.routingContext, receipt, line, {
      chosenBinId: binId,
      speed: get().settings.pickerSpeed,
    })
    if (!plan) return
    set({ putawayPlan: plan, selection: { kind: 'bin', id: plan.chosenBinId } })
  },

  confirmPutaway() {
    const { model, putawayPlan } = get()
    if (!model || !putawayPlan) return
    const receipts = get().receipts
    const receipt = receipts.find((r) => r.id === putawayPlan.receiptId)
    const line = receipt?.lines.find((l) => l.id === putawayPlan.lineId)
    if (!receipt || !line) return

    const at = get().metrics?.time ?? 0
    const result = applyPutaway(model, line, putawayPlan.chosenBinId, at, putawayPlan.route.distance)
    if (!result) {
      get().notify({
        tone: 'error',
        message: 'Putaway rejected',
        detail: 'That location filled up or now holds a different SKU. Re-plan the line.',
      })
      get().planLine(receipt.id, line.id)
      return
    }

    const movement: Movement = {
      id: `${line.id}-${result.binId}-${Math.round(at)}`,
      kind: 'inbound',
      at,
      ref: receipt.ref,
      detail: `${line.name} · ${receipt.supplier}`,
      location: result.code,
      qty: result.qty,
      distance: putawayPlan.route.distance,
      onTime: null,
    }

    set({
      // Receipts are re-created rather than mutated in place so React sees the
      // line's new status; `applyPutaway` already mutated the line object itself.
      receipts: receipts.map((r) => (r.id === receipt.id ? { ...r, lines: [...r.lines] } : r)),
      inboundLog: [...get().inboundLog, movement],
      stockVersion: get().stockVersion + 1,
      putawayPlan: null,
      lastPlacement: {
        binId: result.binId,
        code: result.code,
        name: line.name,
        qty: result.qty,
        remaining: result.remaining,
        distance: putawayPlan.route.distance,
        at,
      },
    })

    get().notify(
      result.remaining > 0
        ? {
            tone: 'warn',
            message: `${result.qty} units placed at ${result.code}`,
            detail: `${result.remaining} units still on the pallet — plan a second location.`,
          }
        : {
            tone: 'success',
            message: `${result.qty} units placed at ${result.code}`,
            detail: `${line.name} · ${Math.round(putawayPlan.route.distance)} m from goods-in`,
          },
    )
  },

  cancelPutaway() {
    set({ activeLine: null, putawayPlan: null })
  },

  dismissPlacement() {
    set({ lastPlacement: null, activeLine: null, selection: null })
  },

  clearReceipts() {
    set({ receipts: [], activeLine: null, putawayPlan: null })
  },

  setSection(section) {
    set({ section })
    // Leaving Inbound drops the roadmap — a route drawn for a line you are no
    // longer looking at is just clutter on the scene.
    if (section !== 'inbound') set({ putawayPlan: null, activeLine: null, lastPlacement: null })
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
