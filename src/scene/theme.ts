import type { Order } from '../simulation/types'
import type { ThemeMode } from '../ui/theme'
import type { VelocityTier } from '../warehouse/types'

export interface SceneTheme {
  background: number
  fog: number
  floor: number
  /** Grid line colour baked into the floor texture. */
  floorGrid: string
  aisleLane: number
  rackUpright: number
  rackDeck: number
  dock: number
  dockDoor: number
  packTop: number
  stagingEdge: number
  curb: number
  /** Selection wireframe. */
  highlight: number
  /** Bins already picked on a route are greyed to this. */
  binDone: number
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
}

const LIGHT: SceneTheme = {
  background: 0xdfe6ee,
  fog: 0xdfe6ee,
  // Albedos are deliberately mid-tone: a light scene needs far less light than a
  // dark one, and painting light surfaces then over-lighting them blows the
  // whole floor out to flat white under ACES tone mapping.
  floor: 0xb9c2cd,
  floorGrid: 'rgba(60,80,100,0.22)',
  aisleLane: 0xc9d2dc,
  rackUpright: 0x4f5c6e,
  rackDeck: 0x707e8f,
  dock: 0x8b97a5,
  dockDoor: 0x2b6cb0,
  packTop: 0x1f8a66,
  stagingEdge: 0x0f7490,
  curb: 0x8d99a7,
  highlight: 0x0b1220,
  binDone: 0x98a4b2,
  ribbonPlan: 0.4,
  ribbonWalked: 1,
  putaway: { route: 0x9a3412, routeOpacity: 0.85, target: 0x7c2d12, candidate: 0x4a3aa7 },
  conveyor: {
    frame: 0x5b6879,
    leg: 0x6f7c8c,
    belt: '#3a4453',
    cleat: '#586576',
    chute: '#8c98a7',
  },
  parcel: { carton: 0xc59355, tape: 0xe8dcc6 },
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
    hemiIntensity: 1.05,
    sunColor: 0xfff6e8,
    sunIntensity: 1.25,
    fillColor: 0xd2e2f2,
    fillIntensity: 0.35,
    exposure: 0.92,
  },
  label: { color: '#1b2430', background: 'rgba(255,255,255,0.94)', border: 'rgba(27,36,48,0.22)' },
  aisleLabel: { color: '#0b5c73', background: 'rgba(255,255,255,0.96)', border: 'rgba(15,116,144,0.45)' },
  marker: { color: '#ffffff', background: 'rgba(20,30,44,0.94)', border: 'rgba(255,255,255,0.6)' },
  staging: { color: '#0b5c73', background: 'rgba(15,116,144,0.14)', border: 'rgba(15,116,144,0.55)' },
}

const DARK: SceneTheme = {
  background: 0x080b11,
  fog: 0x080b11,
  floor: 0x171e28,
  floorGrid: 'rgba(140,170,200,0.16)',
  aisleLane: 0x1f2836,
  rackUpright: 0x4d5d71,
  rackDeck: 0x2a3442,
  dock: 0x243244,
  dockDoor: 0x2f7d8c,
  packTop: 0x3d7f6d,
  stagingEdge: 0x22d3ee,
  curb: 0x101620,
  highlight: 0xffffff,
  binDone: 0x334155,
  ribbonPlan: 0.22,
  ribbonWalked: 0.95,
  putaway: { route: 0xf59e0b, routeOpacity: 0.9, target: 0xfab219, candidate: 0x9085e9 },
  conveyor: {
    frame: 0x38445a,
    leg: 0x2b3646,
    belt: '#161d28',
    cleat: '#2c3745',
    chute: '#48566b',
  },
  parcel: { carton: 0xb07f45, tape: 0xd8ccb6 },
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
    hemiIntensity: 1.55,
    sunColor: 0xe6f2ff,
    sunIntensity: 1.9,
    fillColor: 0x8fbadd,
    fillIntensity: 0.6,
    exposure: 1.22,
  },
  label: { color: '#e6edf5', background: 'rgba(9,13,20,0.82)', border: 'rgba(255,255,255,0.18)' },
  aisleLabel: { color: '#7dd3fc', background: 'rgba(13,20,29,0.9)', border: 'rgba(34,211,238,0.35)' },
  marker: { color: '#ffffff', background: 'rgba(8,12,18,0.94)', border: 'rgba(255,255,255,0.7)' },
  staging: { color: '#a5f3fc', background: 'rgba(34,211,238,0.16)', border: 'rgba(34,211,238,0.5)' },
}

export function sceneTheme(mode: ThemeMode): SceneTheme {
  return mode === 'light' ? LIGHT : DARK
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
