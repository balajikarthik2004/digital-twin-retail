import { buildRoute } from '../pathfinding/route'
import { ROUTING_STRATEGIES } from '../pathfinding/strategies'
import type { RouteStop, RoutingContext } from '../pathfinding/types'
import type { WarehouseModel } from '../warehouse/types'
import type { Order, SimSettings, StrategyComparison } from './types'

/**
 * Run one batch of orders through every routing strategy and report the
 * resulting workload.
 *
 * This is deliberately analytical rather than a full replay: the same pick
 * lists are routed from the same start node with the same pick times, so the
 * only variable is the visiting order. That isolates routing quality from
 * dispatch luck and congestion noise, which is what a stakeholder actually
 * wants to compare. Walk/total times are therefore labelled as estimates in
 * the UI — congestion waiting is excluded by design.
 */
export function compareStrategies(
  model: WarehouseModel,
  ctx: RoutingContext,
  orders: Order[],
  settings: SimSettings,
  strategies = ROUTING_STRATEGIES,
): StrategyComparison[] {
  const start = pickStartNode(model)
  const stopsPerOrder = orders.map((order) => toStops(model, order, settings))

  return strategies.map((strategy) => {
    let totalDistance = 0
    let totalPickTimeSec = 0
    let lines = 0

    stopsPerOrder.forEach((stops) => {
      const route = buildRoute(ctx, strategy, stops, start, start)
      totalDistance += route.distance
      totalPickTimeSec += route.serviceTime
      lines += route.waypoints.length
    })

    const totalWalkTimeSec = totalDistance / Math.max(settings.pickerSpeed, 0.1)
    const unloadSec = orders.length * settings.unloadTimeSec
    const estTotalTimeSec = totalWalkTimeSec + totalPickTimeSec + unloadSec

    return {
      strategyId: strategy.id,
      name: strategy.name,
      blurb: strategy.blurb,
      totalDistance,
      avgDistancePerOrder: orders.length > 0 ? totalDistance / orders.length : 0,
      totalPickTimeSec,
      totalWalkTimeSec,
      estTotalTimeSec,
      estOrdersPerPickerHour: estTotalTimeSec > 0 ? (orders.length / estTotalTimeSec) * 3600 : 0,
      orders: orders.length,
      lines,
    }
  })
}

function toStops(model: WarehouseModel, order: Order, settings: SimSettings): RouteStop[] {
  const stops: RouteStop[] = []
  for (const line of order.lines) {
    const bin = model.binsById.get(line.binId)
    if (!bin) continue
    stops.push({
      node: bin.node,
      ref: bin.id,
      serviceTime: settings.pickTimeSec + settings.perUnitTimeSec * line.qty,
    })
  }
  return stops
}

/** Compare from a single fixed origin so results are strategy-only. */
function pickStartNode(model: WarehouseModel): string {
  return model.facilities.find((f) => f.kind === 'pack')?.node ?? model.depot
}
