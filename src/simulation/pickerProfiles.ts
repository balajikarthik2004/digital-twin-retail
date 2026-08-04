/**
 * Picker embodiments.
 *
 * The choice is not cosmetic: each embodiment carries its own physics, so
 * swapping a hand-carried tote for a pallet truck genuinely changes throughput,
 * batch size and congestion. Factors multiply the operator-set base values, so
 * the walking-speed and handling-time sliders keep working as tuning knobs.
 */
export type PickerKind = 'person' | 'cart' | 'palletJack' | 'amr'

export interface PickerProfile {
  kind: PickerKind
  name: string
  blurb: string
  /** Multiplies the base walking speed. */
  speedFactor: number
  /** Lines that fit in one tour before the picker must return to pack. */
  capacityLines: number
  /** Multiplies per-line handling time. */
  handlingFactor: number
  /** Multiplies pack-out time. */
  unloadFactor: number
  /** Metres of clearance this embodiment needs — drives congestion sensitivity. */
  footprint: number
}

export const PICKER_PROFILES: Record<PickerKind, PickerProfile> = {
  person: {
    kind: 'person',
    name: 'Person (hand tote)',
    blurb: 'Fastest on foot and nimble in tight aisles, but back to pack every ~10 lines.',
    speedFactor: 1.08,
    capacityLines: 10,
    handlingFactor: 0.95,
    unloadFactor: 0.7,
    footprint: 0.6,
  },
  cart: {
    kind: 'cart',
    name: 'Person + pick cart',
    blurb: 'The workhorse. Two totes, good capacity, normal pace.',
    speedFactor: 1,
    capacityLines: 24,
    handlingFactor: 1,
    unloadFactor: 1,
    footprint: 1,
  },
  palletJack: {
    kind: 'palletJack',
    name: 'Person + pallet truck',
    blurb: 'Huge capacity for replen and wholesale, but slow and it blocks an aisle.',
    speedFactor: 0.82,
    capacityLines: 48,
    handlingFactor: 1.2,
    unloadFactor: 1.4,
    footprint: 1.7,
  },
  amr: {
    kind: 'amr',
    name: 'AMR (robot carrier)',
    blurb: 'Travels fast and never tires; drop-off at pack is near-instant.',
    speedFactor: 1.35,
    capacityLines: 20,
    handlingFactor: 1.05,
    unloadFactor: 0.45,
    footprint: 0.9,
  },
}

export const PICKER_KINDS = Object.keys(PICKER_PROFILES) as PickerKind[]

export function profileFor(kind: PickerKind): PickerProfile {
  return PICKER_PROFILES[kind] ?? PICKER_PROFILES.cart
}
