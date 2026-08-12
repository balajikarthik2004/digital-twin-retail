import type { Order } from '../simulation/types'
import type { ThemeMode } from '../ui/theme'
import type { VelocityTier } from '../warehouse/types'

export interface SceneTheme {
  background: number
  fog: number
  floor: number
  /** 1 m scale grid baked into the floor texture. */
  floorGrid: string
  /** Saw-cut slab joint every {@link SLAB_METRES}, and the concrete's tooth. */
  floorJoint: string
  floorSpeckle: string
  aisleLane: number
  rackUpright: number
  rackDeck: number
  /** Front edge of every shelf level — the beam face of the racking. */
  rackBeam: number
  /**
   * Reserve/overstock tier stacked above the pick face — bulk pallet storage
   * reached by turret truck rather than on foot, so it has to read as a
   * distinct rack unit rather than more of the same shelving. A heavier,
   * cooler steel tone than the pick face below it, joined by a load-rated
   * splice beam and a translucent flue-guard mesh across the gap.
   */
  reserveRack: {
    upright: number
    deck: number
    beam: number
    /** Splice beam capping the pick face, at the foot of the gap. */
    separator: number
    /** Flue-guard mesh filling the gap. */
    mesh: number
    meshOpacity: number
  }
  dock: number
  dockDoor: number
  packTop: number
  stagingEdge: number
  curb: number
  /** Selection wireframe. */
  highlight: number
  /** Bins already picked on a route are greyed to this. */
  binDone: number
  /**
   * Occupancy overlay on the racking: what is *not* in a location.
   *
   * Deliberately outside every categorical palette in this scene. `empty` is
   * achromatic — a bare shelf is the absence of a category, so giving it a hue
   * would put it in competition with the velocity tiers and aisle zones it is
   * drawn among. `low` is the warning colour the dashboards already use for a
   * replen alert, so the same condition looks the same in 2D and in 3D.
   */
  occupancy: {
    /** Nothing in it — the location an inbound putaway can re-slot freely. */
    empty: number
    /** At or below its replen point: still picking, about to run out. */
    low: number
  }
  /**
   * Dock doors, by what is moving through them.
   *
   * Both hues are borrowed rather than invented: inbound wears the putaway
   * colour, which already means goods-in everywhere else in the scene, and
   * outbound wears the staging/dispatch colour off the chute signs the parcels
   * arrive down. A door and the work on its pad are therefore the same colour.
   */
  dockFlow: {
    inbound: number
    outbound: number
    idle: number
    /** Emissive lift on the door panel under the pointer. */
    hover: number
    /** Status board face, and the two text weights drawn on it. */
    board: string
    boardText: string
    boardMuted: string
  }
  /** Path-trail opacities: the planned route, and the portion already walked. */
  ribbonPlan: number
  ribbonWalked: number
  /**
   * Inbound putaway roadmap. Deliberately outside the picker identity palette
   * and outside the velocity/zone bin colours, so a route to free space can
   * never be mistaken for a pick path or for a slotting tier.
   */
  putaway: {
    /** The goods-in → shelf ribbon. */
    route: number
    routeOpacity: number
    /** The chosen location. */
    target: number
    /** The runners-up on the shortlist. */
    candidate: number
  }
  /**
   * The building the racking stands in: walls, roof steel, high-bay lighting and
   * the painted floor markings.
   *
   * Deliberately achromatic. Every hue in this scene is already spoken for by
   * data — velocity tiers, aisle zones, sales channels, picker identity — so the
   * envelope carries none of its own and can never be read as a category. The
   * one exception is the lamp colour, which is a light source, not a swatch.
   */
  shell: {
    wall: number
    /** Darker impact skirt around the base of every wall. */
    wallBase: number
    ceiling: number
    truss: number
    /** High-bay fixture housing, and how hard its lens reads as a light source. */
    fixture: number
    fixtureLens: number
    fixtureEmissive: number
    /** Painted safety lanes and the pedestrian walkway across the apron. */
    marking: number
    markingOpacity: number
  }
  /** Outbound conveyor: frame steel, belt surface and its moulded cleats. */
  conveyor: {
    frame: number
    leg: number
    belt: string
    cleat: string
    /** Divert chutes read as a lighter, unpowered slide. */
    chute: string
  }
  /** Cartons on the belt and the shipping label that carries the channel colour. */
  parcel: {
    carton: number
    tape: number
  }
  /**
   * Loose kit on the floor: wrapped pallets in the staging lanes, and the rubber
   * fittings around a dock door. Scenery, so achromatic or material-coloured.
   */
  props: {
    pallet: number
    carton: number
    /** Stretch wrap — translucent, so it reads as film over the cases. */
    wrap: number
    wrapOpacity: number
    rubber: number
  }
  /** Pack bench furniture: the packer's hi-vis, and the andon beacon states. */
  pack: {
    packer: number
    bench: number
    beaconPacking: number
    beaconIdle: number
    beaconBlocked: number
    beaconClosed: number
  }
  lights: {
    skyColor: number
    groundColor: number
    hemiIntensity: number
    sunColor: number
    sunIntensity: number
    fillColor: number
    fillIntensity: number
    exposure: number
    /**
     * Weight of the image-based ambient (a PMREM of a neutral room). This is what
     * puts a believable falloff on the rack steel and the conveyor frames —
     * directional lights alone leave metal reading as flat grey paint.
     */
    envIntensity: number
  }
  /** Canvas-sprite styling for facility, aisle and pick-sequence labels. */
  label: {
    color: string
    background: string
    border: string
  }
  aisleLabel: {
    color: string
    background: string
    border: string
  }
  marker: {
    color: string
    background: string
    border: string
  }
  staging: {
    color: string
    background: string
    border: string
  }
  /**
   * Site safety kit: rack-end impact guards and the reach trucks parked near
   * the reserve aisle. Deliberately near-identical between themes — these are
   * standardised hazard colours on real equipment, not part of the
   * velocity/zone palette, so they should not shift with the rest of the
   * scene the way a data-bearing colour would.
   */
  safety: {
    hazardYellow: number
    hazardBlack: number
    truckBody: number
    truckMast: number
    truckWheel: number
    beacon: number
  }
  /**
   * The mezzanine that puts a picker on the reserve tier: a glass/grating
   * floor at the base of it, and the staircase up from the apron. The floor
   * is deliberately see-through rather than a solid slab — a walkway you
   * can't see the racking through reads as a lid over the module, not a
   * second storey of it.
   */
  mezzanine: {
    /** Faint tint on the glass — enough to read as a surface, not a hole in the air. */
    floorTint: number
    floorOpacity: number
    /** The grid baked into the floor texture, standing in for wired safety glass or bar grating. */
    grating: number
    stairTread: number
  }
}

const LIGHT: SceneTheme = {
  background: 0xdfe6ee,
  fog: 0xdfe6ee,
  // Albedos are deliberately mid-tone: a light scene needs far less light than a
  // dark one, and painting light surfaces then over-lighting them blows the
  // whole floor out to flat white under ACES tone mapping.
  floor: 0xb9c2cd,
  floorGrid: 'rgba(60,80,100,0.14)',
  floorJoint: 'rgba(46,62,80,0.34)',
  floorSpeckle: 'rgba(38,52,68,0.10)',
  aisleLane: 0xc9d2dc,
  rackUpright: 0x4f5c6e,
  rackDeck: 0x707e8f,
  rackBeam: 0x5b6879,
  reserveRack: {
    upright: 0x3d4a5c,
    deck: 0x5c6773,
    beam: 0x46536a,
    separator: 0xb45309,
    mesh: 0x3c4a5c,
    meshOpacity: 0.3,
  },
  dock: 0x8b97a5,
  dockDoor: 0x2b6cb0,
  packTop: 0x1f8a66,
  stagingEdge: 0x0f7490,
  curb: 0x8d99a7,
  highlight: 0x0b1220,
  binDone: 0x98a4b2,
  occupancy: { empty: 0xf4f7fb, low: 0xb45309 },
  dockFlow: {
    inbound: 0x9a3412,
    outbound: 0x0f7490,
    idle: 0x8b97a5,
    hover: 0x1b2430,
    board: 'rgba(248,250,252,0.96)',
    boardText: '#16202c',
    boardMuted: 'rgba(22,32,44,0.55)',
  },
  ribbonPlan: 0.4,
  ribbonWalked: 1,
  putaway: { route: 0x9a3412, routeOpacity: 0.85, target: 0x7c2d12, candidate: 0x4a3aa7 },
  shell: {
    wall: 0xdde3ea,
    wallBase: 0x93a0af,
    ceiling: 0xcdd5dd,
    truss: 0x8b98a8,
    fixture: 0x8e9aa8,
    fixtureLens: 0xfffdf4,
    // A daylit building barely shows its lamps; the housings still read as steel.
    fixtureEmissive: 0.55,
    marking: 0xfafbfc,
    markingOpacity: 0.92,
  },
  conveyor: {
    frame: 0x5b6879,
    leg: 0x6f7c8c,
    belt: '#3a4453',
    cleat: '#586576',
    chute: '#8c98a7',
  },
  parcel: { carton: 0xc59355, tape: 0xe8dcc6 },
  props: {
    pallet: 0x9b7a4e,
    carton: 0xbe8f56,
    wrap: 0xdfe7ee,
    wrapOpacity: 0.24,
    rubber: 0x2c333c,
  },
  pack: {
    packer: 0xeda100,
    bench: 0x8b97a5,
    beaconPacking: 0x0ca30c,
    beaconIdle: 0xb8860b,
    beaconBlocked: 0xd03b3b,
    beaconClosed: 0x94a3b8,
  },
  lights: {
    skyColor: 0xffffff,
    groundColor: 0xb4c0ce,
    // Trimmed when the image-based ambient came in, so total illumination — and
    // therefore the tone-mapped floor — is unchanged; the IBL replaces part of
    // the flat hemisphere with light that has direction to it.
    hemiIntensity: 0.9,
    sunColor: 0xfff6e8,
    sunIntensity: 1.25,
    fillColor: 0xd2e2f2,
    fillIntensity: 0.35,
    exposure: 0.92,
    // Daylit: the sun already carries the scene, so the ambient stays a whisper.
    envIntensity: 0.3,
  },
  label: { color: '#1b2430', background: 'rgba(255,255,255,0.94)', border: 'rgba(27,36,48,0.22)' },
  aisleLabel: { color: '#0b5c73', background: 'rgba(255,255,255,0.96)', border: 'rgba(15,116,144,0.45)' },
  marker: { color: '#ffffff', background: 'rgba(20,30,44,0.94)', border: 'rgba(255,255,255,0.6)' },
  staging: { color: '#0b5c73', background: 'rgba(15,116,144,0.14)', border: 'rgba(15,116,144,0.55)' },
  safety: {
    hazardYellow: 0xf5c518,
    hazardBlack: 0x1c1f24,
    truckBody: 0xf2a900,
    truckMast: 0x2b2f36,
    truckWheel: 0x14171b,
    beacon: 0xffb020,
  },
  mezzanine: {
    floorTint: 0xb9d1e8,
    floorOpacity: 0.78,
    grating: 0x2f3f52,
    stairTread: 0x707e8f,
  },
}

const DARK: SceneTheme = {
  background: 0x080b11,
  fog: 0x080b11,
  floor: 0x171e28,
  floorGrid: 'rgba(140,170,200,0.10)',
  floorJoint: 'rgba(150,180,212,0.22)',
  floorSpeckle: 'rgba(170,196,224,0.07)',
  aisleLane: 0x1f2836,
  rackUpright: 0x4d5d71,
  rackDeck: 0x2a3442,
  rackBeam: 0x3c4a5c,
  reserveRack: {
    upright: 0x394759,
    deck: 0x1f2733,
    beam: 0x2f3c4d,
    separator: 0xf0a83a,
    mesh: 0x8cacc8,
    meshOpacity: 0.24,
  },
  dock: 0x243244,
  dockDoor: 0x2f7d8c,
  packTop: 0x3d7f6d,
  stagingEdge: 0x22d3ee,
  curb: 0x101620,
  highlight: 0xffffff,
  binDone: 0x334155,
  occupancy: { empty: 0xdfe7f1, low: 0xf0a83a },
  dockFlow: {
    inbound: 0xf59e0b,
    outbound: 0x22d3ee,
    idle: 0x475569,
    hover: 0xffffff,
    board: 'rgba(9,13,20,0.9)',
    boardText: '#e9f1fa',
    boardMuted: 'rgba(233,241,250,0.6)',
  },
  ribbonPlan: 0.22,
  ribbonWalked: 0.95,
  putaway: { route: 0xf59e0b, routeOpacity: 0.9, target: 0xfab219, candidate: 0x9085e9 },
  shell: {
    wall: 0x1a2230,
    wallBase: 0x0c111a,
    ceiling: 0x141b25,
    truss: 0x2b3644,
    fixture: 0x27313e,
    fixtureLens: 0xfff3d6,
    // A night shift is lit by its own high bays, so the lenses have to carry it.
    fixtureEmissive: 1.35,
    marking: 0x8b9db3,
    markingOpacity: 0.58,
  },
  conveyor: {
    frame: 0x38445a,
    leg: 0x2b3646,
    belt: '#161d28',
    cleat: '#2c3745',
    chute: '#48566b',
  },
  parcel: { carton: 0xb07f45, tape: 0xd8ccb6 },
  props: {
    pallet: 0x7d613d,
    carton: 0xa07641,
    wrap: 0x9fb3c6,
    wrapOpacity: 0.2,
    rubber: 0x141a21,
  },
  pack: {
    packer: 0xc98500,
    bench: 0x2a3549,
    beaconPacking: 0x0ca30c,
    beaconIdle: 0xfab219,
    beaconBlocked: 0xe66767,
    beaconClosed: 0x64748b,
  },
  lights: {
    skyColor: 0xa8cbe8,
    groundColor: 0x161d27,
    // Same trade as the light theme; see the note there.
    hemiIntensity: 1.35,
    sunColor: 0xe6f2ff,
    sunIntensity: 1.9,
    fillColor: 0x8fbadd,
    fillIntensity: 0.6,
    exposure: 1.22,
    // A dark interior leans on bounced light, so the ambient carries more of it.
    envIntensity: 0.5,
  },
  label: { color: '#e6edf5', background: 'rgba(9,13,20,0.82)', border: 'rgba(255,255,255,0.18)' },
  aisleLabel: { color: '#7dd3fc', background: 'rgba(13,20,29,0.9)', border: 'rgba(34,211,238,0.35)' },
  marker: { color: '#ffffff', background: 'rgba(8,12,18,0.94)', border: 'rgba(255,255,255,0.7)' },
  staging: { color: '#a5f3fc', background: 'rgba(34,211,238,0.16)', border: 'rgba(34,211,238,0.5)' },
  safety: {
    hazardYellow: 0xe6b800,
    hazardBlack: 0x11151c,
    truckBody: 0xe0a600,
    truckMast: 0x3a4150,
    truckWheel: 0x0c0f14,
    beacon: 0xffc94a,
  },
  mezzanine: {
    floorTint: 0x6f8caa,
    floorOpacity: 0.68,
    grating: 0xbfd4ea,
    stairTread: 0x2a3442,
  },
}

export function sceneTheme(mode: ThemeMode): SceneTheme {
  return mode === 'light' ? LIGHT : DARK
}

/** The dock flow colours as CSS, so a panel chip matches the lamp on the door. */
export function dockFlowHex(mode: ThemeMode): Record<'inbound' | 'outbound' | 'idle', string> {
  const f = sceneTheme(mode).dockFlow
  return { inbound: hex(f.inbound), outbound: hex(f.outbound), idle: hex(f.idle) }
}

/** The occupancy overlay colours as CSS, for the legend beside the toggle. */
export function occupancyHex(mode: ThemeMode): Record<'empty' | 'low', string> {
  const o = sceneTheme(mode).occupancy
  return { empty: hex(o.empty), low: hex(o.low) }
}

export const OCCUPANCY_LABEL: Record<'empty' | 'low', string> = {
  empty: 'Empty location',
  low: 'At or below replen',
}

function hex(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`
}

/**
 * SKU velocity tiers, read hot (fast) -> cool (medium) -> cold (slow).
 *
 * These are categorical slots 2 / 3 / 1 of the validated palette, which is the
 * only trio documented as clearing every all-pairs gate in BOTH modes. A literal
 * hot/warm/cold ramp (red / yellow / blue) was tried first and rejected: on a
 * dark surface the lightness band is narrow, and red↔yellow at equal lightness
 * collapse to ΔE ~3 under deuteranopia. Lightness separation is what rescues
 * that pair, and the dark band has no room for it.
 *
 * Verified with the data-viz validator against the card surface AND the 3D floor
 * of each mode:
 *   node scripts/validate_palette.js "#eb6834,#1baf7a,#2a78d6" \
 *     --mode light --surface "#ffffff" --pairs all   -> ALL CHECKS PASS
 *   node scripts/validate_palette.js "#eb6834,#1baf7a,#2a78d6" \
 *     --mode light --surface "#b9c2cd" --pairs all   -> ALL CHECKS PASS
 *   node scripts/validate_palette.js "#d95926,#199e70,#3987e5" \
 *     --mode dark  --surface "#131a24" --pairs all   -> ALL CHECKS PASS
 *   node scripts/validate_palette.js "#d95926,#199e70,#3987e5" \
 *     --mode dark  --surface "#171e28" --pairs all   -> ALL CHECKS PASS
 * Sub-3:1 contrast WARNs against the floor are covered by the relief rule: the
 * legend always ships a visible tier label beside every swatch.
 */
const VELOCITY: Record<ThemeMode, Record<VelocityTier, number>> = {
  light: { fast: 0x1baf7a, medium: 0xeb6834, slow: 0x2a78d6 },
  dark: { fast: 0x199e70, medium: 0xd95926, slow: 0x3987e5 },
}

export function velocityColors(mode: ThemeMode): Record<VelocityTier, number> {
  return VELOCITY[mode]
}

export function velocityHex(mode: ThemeMode): Record<VelocityTier, string> {
  const c = VELOCITY[mode]
  return {
    fast: `#${c.fast.toString(16).padStart(6, '0')}`,
    medium: `#${c.medium.toString(16).padStart(6, '0')}`,
    slow: `#${c.slow.toString(16).padStart(6, '0')}`,
  }
}

export const VELOCITY_LABEL: Record<VelocityTier, string> = {
  fast: 'Fast mover (A)',
  medium: 'Medium mover (B)',
  slow: 'Slow mover (C)',
}

/**
 * Zone tint for the "colour by aisle zone" mode — genuinely categorical, so
 * these are the validated categorical orders, assigned in fixed order.
 */
const ZONES: Record<ThemeMode, number[]> = {
  light: [
    0x2a78d6, 0xeb6834, 0x1baf7a, 0xeda100, 0xe87ba4, 0x008300, 0x4a3aa7, 0xe34948, 0x0f7490,
    0x9a3412, 0x155e75, 0x7c2d12,
  ],
  dark: [
    0x3987e5, 0xd95926, 0x199e70, 0xc98500, 0xd55181, 0x008300, 0x9085e9, 0xe66767, 0x22d3ee,
    0x34d399, 0x818cf8, 0xf59e0b,
  ],
}

export function zoneColors(mode: ThemeMode): number[] {
  return ZONES[mode]
}

/**
 * Sales channel colours, worn by the shipping label on each parcel and by the
 * legend chips beside it.
 *
 * These are slots 1 / 3 / 4 / 8 of the same validated categorical orders used
 * for zones, so no new hues are introduced. A carton stays cardboard-coloured
 * and only its label is tinted — the relief rule is satisfied because every
 * swatch in the dashboard ships its channel name beside it, and the parcel card
 * names the channel in text.
 */
const CHANNELS: Record<ThemeMode, Record<Order['channel'], number>> = {
  light: {
    Ecommerce: 0x2a78d6,
    'Click & Collect': 0x1baf7a,
    'Store Replen': 0xeda100,
    Wholesale: 0xe34948,
  },
  dark: {
    Ecommerce: 0x3987e5,
    'Click & Collect': 0x199e70,
    'Store Replen': 0xc98500,
    Wholesale: 0xe66767,
  },
}

export function channelColors(mode: ThemeMode): Record<Order['channel'], number> {
  return CHANNELS[mode]
}

export function channelHex(mode: ThemeMode): Record<Order['channel'], string> {
  const c = CHANNELS[mode]
  return {
    Ecommerce: `#${c.Ecommerce.toString(16).padStart(6, '0')}`,
    'Click & Collect': `#${c['Click & Collect'].toString(16).padStart(6, '0')}`,
    'Store Replen': `#${c['Store Replen'].toString(16).padStart(6, '0')}`,
    Wholesale: `#${c.Wholesale.toString(16).padStart(6, '0')}`,
  }
}
