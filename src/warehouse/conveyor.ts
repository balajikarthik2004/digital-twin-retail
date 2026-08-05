/**
 * Outbound conveyor network — the physical link between packing and dispatch.
 *
 * Topology, in section (z runs front-to-back, the racks are to the right):
 *
 *        racks
 *   ─────────────────────────────────────────────  storage face
 *      ▭ Pack 01     ▭ Pack 02     ▭ Pack 03        benches
 *       │ takeaway spur (rises 1.0 m → 2.45 m)
 *   ════╪═════════════╪═════════════╪══════════▶    overhead takeaway trunk
 *                                              ║    cross-over at the end
 *   ◀═══════════════════════════════════════════    outbound sorter (0.78 m)
 *        ╲ chute       ╲ chute        ╲ chute
 *      ▤ Dock 01     ▤ Dock 02      ▤ Dock 03       staged for loading
 *
 * One unidirectional loop, so a parcel from any bench can reach any dock without
 * ever running backwards — which is exactly why real DCs build the return leg
 * rather than reversing a belt. Every coordinate is derived from the layout
 * config, so the network re-fits itself to any warehouse in `layouts.json`.
 */

export interface Vec3 {
  x: number
  y: number
  z: number
}

/** A polyline with pre-computed arc lengths, so sampling is a binary search. */
export interface ConveyorRun {
  polyline: Vec3[]
  cumulative: number[]
  length: number
}

export interface ConveyorSpur extends ConveyorRun {
  /** Pack station facility this takeaway belongs to. */
  facilityId: string
  label: string
  /** Arc length along the trunk where this spur merges in. */
  mergeArc: number
}

export interface ConveyorChute extends ConveyorRun {
  /** Dock facility parcels on this chute are destined for. */
  facilityId: string
  label: string
  /** Arc length along the trunk where parcels divert onto the chute. */
  divertArc: number
  /** Floor point where parcels stack waiting for the trailer. */
  stagePos: Vec3
}

export interface ConveyorNetwork {
  trunk: ConveyorRun
  /** Indexed by pack station, in facility order. */
  spurs: ConveyorSpur[]
  /** Indexed by dock, in facility order. */
  chutes: ConveyorChute[]
  beltWidth: number
  /** Elevation of the overhead takeaway run and of the low outbound sorter. */
  highY: number
  lowY: number
  /** Support legs, so the scene can stand the trunk up without re-deriving it. */
  legs: { x: number; z: number; height: number }[]
  /** Which leg of the loop each trunk segment belongs to, for labelling. */
  labels: { text: string; pos: Vec3 }[]
}

export type ConveyorLeg = 'spur' | 'trunk' | 'chute'

export interface ConveyorPose {
  pos: Vec3
  /** Facing angle (radians) of travel, for orienting a parcel. */
  heading: number
  leg: ConveyorLeg
  /** Position in trunk arc space — only meaningful while `leg` is `trunk`. */
  trunkArc: number
}

export interface ConveyorBuildInput {
  packStations: { id: string; label: string; x: number; z: number; depth: number }[]
  docks: { id: string; label: string; x: number; z: number }[]
  bounds: { minX: number; maxX: number }
  /** Front face of the racking — the conveyor lives entirely in front of it. */
  storageMinZ: number
  apronDepth: number
}

const BELT_WIDTH = 0.62
const HIGH_Y = 2.45
const LOW_Y = 0.78
/** Bench-top height of the takeaway pick-up point. */
const TAKEAWAY_Y = 1.02
const LEG_SPACING = 7

export function buildConveyorNetwork(input: ConveyorBuildInput): ConveyorNetwork {
  const { packStations, docks, bounds, storageMinZ, apronDepth } = input

  const packXs = packStations.map((p) => p.x)
  const dockXs = docks.map((d) => d.x)
  const dockZ = docks[0]?.z ?? storageMinZ - apronDepth * 0.88

  // Trunk sits between the benches and the apron walking lane; the return leg
  // sits between the outbound staging apron and the dock doors.
  const trunkZ = storageMinZ - apronDepth * 0.36
  const returnZ = dockZ + clamp(apronDepth * 0.25, 2.4, 4)

  const xStart = Math.max(bounds.minX + 0.8, Math.min(...packXs, 0) - 2.4)
  const xEnd = bounds.maxX - 1.2
  const maxDockX = Math.max(...dockXs, xStart)
  // The decline has to finish upstream of the furthest dock, otherwise a chute
  // would have to divert off a sloping section.
  const declineLen = clamp(Math.min(4.5, xEnd - maxDockX - 0.9), 1.8, 6)
  const xDeclineEnd = xEnd - declineLen
  const xReturnEnd = Math.max(bounds.minX + 0.8, Math.min(...dockXs, xDeclineEnd) - 2)

  const trunk = makeRun([
    { x: xStart, y: HIGH_Y, z: trunkZ },
    { x: xEnd, y: HIGH_Y, z: trunkZ },
    { x: xEnd, y: HIGH_Y, z: returnZ },
    { x: xDeclineEnd, y: LOW_Y, z: returnZ },
    { x: xReturnEnd, y: LOW_Y, z: returnZ },
  ])

  const spurs: ConveyorSpur[] = packStations.map((station) => {
    const benchFront = station.z - station.depth / 2
    const run = makeRun([
      { x: station.x, y: TAKEAWAY_Y, z: benchFront - 0.12 },
      { x: station.x, y: TAKEAWAY_Y, z: benchFront - 0.55 },
      { x: station.x, y: HIGH_Y, z: trunkZ },
    ])
    return {
      ...run,
      facilityId: station.id,
      label: station.label,
      // The trunk's first segment runs along +x at `trunkZ`, so arc == Δx.
      mergeArc: clamp(station.x - xStart, 0, trunk.length),
    }
  })

  const chutes: ConveyorChute[] = docks.map((dock) => {
    const divertX = clamp(dock.x, xReturnEnd + 0.4, xDeclineEnd - 0.4)
    const stageZ = dockZ + 1.15
    const run = makeRun([
      { x: divertX, y: LOW_Y, z: returnZ },
      { x: divertX, y: LOW_Y - 0.04, z: returnZ - 0.55 },
      { x: dock.x, y: 0.52, z: (returnZ + stageZ) / 2 - 0.1 },
      { x: dock.x, y: 0.3, z: stageZ + 0.2 },
    ])
    return {
      ...run,
      facilityId: dock.id,
      label: dock.label,
      divertArc: trunkArcAtReturnX(trunk, divertX),
      stagePos: { x: dock.x, y: 0.16, z: stageZ },
    }
  })

  // Legs are deliberately placed between the benches rather than in front of
  // them, so no upright ever lands on the path a picker walks to pack-out.
  const legs: { x: number; z: number; height: number }[] = []
  const gateXs = [...packXs].sort((a, b) => a - b)
  const legXs = new Set<number>([xStart + 0.4, xEnd - 0.4])
  for (let i = 1; i < gateXs.length; i++) legXs.add((gateXs[i - 1] + gateXs[i]) / 2)
  for (let x = xStart + LEG_SPACING; x < xEnd - 1; x += LEG_SPACING) {
    if (gateXs.every((px) => Math.abs(px - x) > 1.6)) legXs.add(x)
  }
  for (const x of legXs) legs.push({ x, z: trunkZ, height: HIGH_Y })
  legs.push({ x: xEnd - 0.4, z: returnZ, height: HIGH_Y })
  for (let x = xReturnEnd + 1; x < xDeclineEnd; x += LEG_SPACING) {
    legs.push({ x, z: returnZ, height: LOW_Y })
  }

  const labels = [
    { text: 'Takeaway conveyor', pos: { x: (xStart + xEnd) / 2, y: HIGH_Y + 0.85, z: trunkZ } },
    {
      text: 'Outbound sorter',
      pos: { x: (xReturnEnd + xDeclineEnd) / 2, y: LOW_Y + 0.8, z: returnZ },
    },
  ]

  return { trunk, spurs, chutes, beltWidth: BELT_WIDTH, highY: HIGH_Y, lowY: LOW_Y, legs, labels }
}

/** Total belt distance a parcel covers from a bench to a dock. */
export function conveyorPathLength(
  net: ConveyorNetwork,
  spurIndex: number,
  chuteIndex: number,
): number {
  const spur = net.spurs[spurIndex]
  const chute = net.chutes[chuteIndex]
  if (!spur || !chute) return 0
  return spur.length + trunkSpan(spur, chute) + chute.length
}

/** Pose at `arc` metres along the bench → dock path. */
export function sampleConveyor(
  net: ConveyorNetwork,
  spurIndex: number,
  chuteIndex: number,
  arc: number,
): ConveyorPose {
  const spur = net.spurs[spurIndex]
  const chute = net.chutes[chuteIndex]
  if (!spur || !chute) {
    return { pos: { x: 0, y: 0, z: 0 }, heading: 0, leg: 'spur', trunkArc: 0 }
  }

  if (arc <= spur.length) {
    const pose = sampleRun(spur, arc)
    return { ...pose, leg: 'spur', trunkArc: spur.mergeArc }
  }

  const span = trunkSpan(spur, chute)
  const onTrunk = arc - spur.length
  if (onTrunk <= span) {
    const trunkArc = spur.mergeArc + onTrunk
    const pose = sampleRun(net.trunk, trunkArc)
    return { ...pose, leg: 'trunk', trunkArc }
  }

  const pose = sampleRun(chute, onTrunk - span)
  return { ...pose, leg: 'chute', trunkArc: chute.divertArc }
}

/** Arc along the trunk between a spur's merge point and a chute's divert point. */
function trunkSpan(spur: ConveyorSpur, chute: ConveyorChute): number {
  return Math.max(0, chute.divertArc - spur.mergeArc)
}

function makeRun(points: Vec3[]): ConveyorRun {
  const cumulative = [0]
  for (let i = 1; i < points.length; i++) {
    cumulative.push(cumulative[i - 1] + distance(points[i - 1], points[i]))
  }
  return { polyline: points, cumulative, length: cumulative[cumulative.length - 1] }
}

function sampleRun(run: ConveyorRun, arc: number): { pos: Vec3; heading: number } {
  const { polyline, cumulative } = run
  if (polyline.length === 0) return { pos: { x: 0, y: 0, z: 0 }, heading: 0 }
  if (polyline.length === 1) return { pos: { ...polyline[0] }, heading: 0 }

  const target = clamp(arc, 0, run.length)
  let lo = 0
  let hi = cumulative.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (cumulative[mid] <= target) lo = mid
    else hi = mid
  }

  const a = polyline[lo]
  const b = polyline[hi]
  const segLen = cumulative[hi] - cumulative[lo]
  const t = segLen > 1e-6 ? (target - cumulative[lo]) / segLen : 0
  return {
    pos: { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) },
    heading: Math.atan2(b.x - a.x, b.z - a.z),
  }
}

/** Arc length of the point on the low return leg sitting at world x. */
function trunkArcAtReturnX(trunk: ConveyorRun, x: number): number {
  const points = trunk.polyline
  // Walk backwards: the return leg is the last segment of the loop.
  for (let i = points.length - 1; i > 0; i--) {
    const a = points[i - 1]
    const b = points[i]
    const dx = b.x - a.x
    if (Math.abs(dx) < 1e-6) continue
    const t = (x - a.x) / dx
    if (t >= 0 && t <= 1) {
      return trunk.cumulative[i - 1] + (trunk.cumulative[i] - trunk.cumulative[i - 1]) * t
    }
  }
  return trunk.length
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}
