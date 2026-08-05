import type { Route, Vec2 } from '../pathfinding/types'
import type { Bin, WarehouseModel } from '../warehouse/types'
import type { RouteStep } from './types'

/**
 * Turn the nav-graph polyline into instructions a person can follow.
 *
 * The route the pickers walk is already a sequence of aisle and cross-aisle
 * nodes, so the directions are not invented — they are that same path, collapsed
 * into straight legs and named with the landmarks painted on the floor.
 */

/** Two points closer than this on an axis are treated as collinear. */
const AXIS_TOLERANCE = 0.05

interface Leg {
  axis: 'x' | 'y'
  from: Vec2
  to: Vec2
  length: number
}

function collapse(polyline: Vec2[]): Leg[] {
  const legs: Leg[] = []
  for (let i = 1; i < polyline.length; i++) {
    const from = polyline[i - 1]
    const to = polyline[i]
    const dx = to.x - from.x
    const dy = to.y - from.y
    const length = Math.hypot(dx, dy)
    if (length < AXIS_TOLERANCE) continue

    const axis: 'x' | 'y' = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y'
    const previous = legs[legs.length - 1]
    // Merge consecutive legs running the same way, so a chain of bay nodes reads
    // as one "walk 18 m down the aisle" rather than eight one-metre hops.
    if (
      previous &&
      previous.axis === axis &&
      Math.sign(axis === 'x' ? dx : dy) ===
        Math.sign(axis === 'x' ? previous.to.x - previous.from.x : previous.to.y - previous.from.y)
    ) {
      previous.to = to
      previous.length += length
      continue
    }
    legs.push({ axis, from, to, length })
  }
  return legs
}

/** Aisle index whose centreline `x` sits on, or null when it is between aisles. */
function aisleAt(model: WarehouseModel, x: number): number | null {
  let best: number | null = null
  let bestD = model.config.aisleWidth * 0.35
  model.aisleX.forEach((ax, a) => {
    const d = Math.abs(ax - x)
    if (d < bestD) {
      bestD = d
      best = a
    }
  })
  return best
}

export function aisleLabel(aisle: number): string {
  return `A${String(aisle + 1).padStart(2, '0')}`
}

/** Name of the horizontal lane at depth `y`. */
function laneAt(model: WarehouseModel, y: number): string {
  const half = model.config.crossAisleWidth * 0.6
  for (let c = 0; c < model.crossZ.length; c++) {
    if (Math.abs(model.crossZ[c] - y) > half) continue
    if (c === 0) return 'front cross aisle'
    if (c === model.crossZ.length - 1) return 'back cross aisle'
    return `cross aisle ${c + 1}`
  }
  return 'apron'
}

const SLOT_LETTER = (slot: number) => String.fromCharCode(65 + slot)

/**
 * Build the step-by-step walk from goods-in to a storage location.
 *
 * @param route  Any route whose polyline ends at `target`'s pick point.
 */
export function describeRoute(model: WarehouseModel, route: Route, target: Bin): RouteStep[] {
  const legs = collapse(route.polyline)
  const steps: RouteStep[] = []
  const push = (text: string, metres: number) =>
    steps.push({ index: steps.length + 1, text, metres })

  if (legs.length === 0) {
    push(`You are already standing at ${target.code}.`, 0)
  }

  legs.forEach((leg, i) => {
    const metres = Math.round(leg.length)
    const last = i === legs.length - 1

    if (leg.axis === 'y') {
      const aisle = aisleAt(model, leg.to.x)
      const deeper = leg.to.y > leg.from.y
      if (aisle === null) {
        push(
          i === 0
            ? `Leave Inbound Receiving and step out onto the apron — ${metres} m.`
            : deeper
              ? `Cross the apron towards the racking — ${metres} m.`
              : `Come back out towards the dock apron — ${metres} m.`,
          metres,
        )
        return
      }
      if (last) {
        push(
          `${i === 0 ? 'Walk' : 'Turn'} into aisle ${aisleLabel(aisle)} and go ${metres} m ${
            deeper ? 'in' : 'back'
          } to bay ${target.bay + 1}.`,
          metres,
        )
      } else {
        push(
          `Pass ${deeper ? 'up' : 'down'} aisle ${aisleLabel(aisle)} for ${metres} m to the ${laneAt(
            model,
            leg.to.y,
          )}.`,
          metres,
        )
      }
      return
    }

    // Horizontal leg — along the apron or a cross aisle, towards a numbered aisle.
    const lane = laneAt(model, leg.from.y)
    const aisle = aisleAt(model, leg.to.x)
    const heading = leg.to.x > leg.from.x ? 'right' : 'left'
    const landmark = aisle !== null ? ` to the head of aisle ${aisleLabel(aisle)}` : ''
    push(
      i === 0
        ? `Leave Inbound Receiving and head ${heading} along the ${lane} for ${metres} m${landmark}.`
        : `Follow the ${lane} ${heading} for ${metres} m${landmark}.`,
      metres,
    )
  })

  push(
    `Stop at ${target.code} — ${target.side === 'L' ? 'left' : 'right'}-hand rack, level ${
      target.level + 1
    } (${target.face.y.toFixed(1)} m up), slot ${SLOT_LETTER(target.slot)}.`,
    0,
  )

  return steps
}

/**
 * Seconds to walk the route and physically put the stock away: the walk at the
 * current pace, a fixed allowance for getting the pallet down and scanned, and
 * a handling rate per unit.
 */
export function estimatePutawaySec(
  distance: number,
  units: number,
  opts: { speed: number; setupSec?: number; perUnitSec?: number },
): number {
  const speed = Math.max(0.2, opts.speed)
  const setup = opts.setupSec ?? 45
  const perUnit = opts.perUnitSec ?? 0.8
  return distance / speed + setup + units * perUnit
}
