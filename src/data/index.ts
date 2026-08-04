import type { Order } from '../simulation/types'
import { importOrders } from '../simulation/orderGenerator'
import type { WarehouseConfig, WarehouseModel } from '../warehouse/types'
import layoutsDoc from './layouts.json'
import sampleOrdersDoc from './sampleOrders.json'

/**
 * Data access boundary.
 *
 * Everything the app knows about layouts and orders arrives through this
 * interface, so replacing the bundled JSON with a real WMS/API is a matter of
 * providing another implementation — no UI, scene or simulation code changes.
 *
 *   // src/data/httpSource.ts
 *   export const httpSource: DataSource = {
 *     id: 'api',
 *     label: 'WMS API',
 *     async listLayouts()      { return (await fetch('/api/layouts')).json() },
 *     async defaultLayoutId()  { return 'dc-north' },
 *     async loadOrders(model)  { return importOrders(model, await (await fetch('/api/waves/current')).json()).orders },
 *   }
 *
 * then swap the export at the bottom of this file (or select at runtime).
 */
export interface DataSource {
  id: string
  label: string
  listLayouts(): Promise<WarehouseConfig[]>
  defaultLayoutId(): Promise<string>
  /** Orders resolved against a generated model, so bin references can be validated. */
  loadOrders(model: WarehouseModel): Promise<Order[]>
}

interface LayoutsDoc {
  defaultLayoutId: string
  layouts: WarehouseConfig[]
}

const doc = layoutsDoc as unknown as LayoutsDoc

export const localSource: DataSource = {
  id: 'local',
  label: 'Bundled sample data',
  async listLayouts() {
    return doc.layouts
  },
  async defaultLayoutId() {
    return doc.defaultLayoutId
  },
  async loadOrders(model) {
    // Sample orders are hand-written against the default layout. On other
    // layouts some codes will not resolve, so fall back to generated demand.
    try {
      const { orders } = importOrders(model, sampleOrdersDoc)
      return orders
    } catch {
      return []
    }
  },
}

export const activeSource: DataSource = localSource

export { sampleOrdersDoc as SAMPLE_ORDERS_DOC }
