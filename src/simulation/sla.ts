import type { Order } from './types'

/** Service-level windows by priority, in minutes from release. */
export const SLA_MINUTES = { express: 30, standard: 120 } as const

/** When an order must be packed by, in simulation seconds. */
export function slaFor(order: Pick<Order, 'priority' | 'releasedAt'>): number {
  return order.releasedAt + SLA_MINUTES[order.priority] * 60
}
