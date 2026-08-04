export type ThemeMode = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'picktwin.theme'

/**
 * Chart tokens, per mode.
 *
 * Both modes are *selected*, not flipped: each set was validated with the
 * data-viz validator against the surface it actually renders on.
 *
 *   light: node scripts/validate_palette.js "#2a78d6,#eb6834,#1baf7a" \
 *            --mode light --surface "#ffffff" --pairs all   -> ALL CHECKS PASS
 *   dark:  node scripts/validate_palette.js "#3987e5,#d95926,#199e70" \
 *            --mode dark  --surface "#131a24" --pairs all   -> ALL CHECKS PASS
 *
 * The aqua/green slot carries a sub-3:1 contrast WARN on white; the relief rule
 * applies and is satisfied — every chart here ships direct value labels and a
 * table view. Status colours are fixed and never themed.
 */
export interface ChartPalette {
  surface: string
  textPrimary: string
  textSecondary: string
  muted: string
  grid: string
  /** Categorical slots 1-3, used for the walk / pick / pack breakdown. */
  series: [string, string, string]
  /** Ordinal pair for single-measure bars: the winner gets `barBest`. */
  barBest: string
  barBase: string
  /** Single-series sequential hue (throughput line/area). */
  sequential: string
  good: string
  warning: string
  critical: string
}

const LIGHT: ChartPalette = {
  surface: '#ffffff',
  textPrimary: '#1b2430',
  textSecondary: '#4c5a6b',
  muted: '#6b7a8d',
  grid: '#e3e8ee',
  series: ['#2a78d6', '#eb6834', '#1baf7a'],
  // On a light surface the darker step is the prominent one.
  barBest: '#1c5cab',
  barBase: '#86b6ef',
  sequential: '#2a78d6',
  good: '#0ca30c',
  warning: '#fab219',
  critical: '#d03b3b',
}

const DARK: ChartPalette = {
  surface: '#131a24',
  textPrimary: '#e8eef6',
  textSecondary: '#a7b4c4',
  muted: '#74839a',
  grid: '#1e2833',
  series: ['#3987e5', '#d95926', '#199e70'],
  // On a dark surface the lighter step is the prominent one.
  barBest: '#6da7ec',
  barBase: '#256abf',
  sequential: '#3987e5',
  good: '#0ca30c',
  warning: '#fab219',
  critical: '#d03b3b',
}

export function chartPalette(mode: ThemeMode): ChartPalette {
  return mode === 'light' ? LIGHT : DARK
}

/**
 * Picker identity colours — categorical, assigned in fixed order and never cycled.
 *
 * Deliberately rotated to open on violet / magenta / yellow / green: the SKU
 * velocity tiers own orange, aqua and blue (see `src/scene/theme.ts`), and a
 * picker's floor trail sits right next to the bins it is walking past. With the
 * usual 1-5 pickers there is no hue shared with the tiers at all; slots 5-8 do
 * reuse them, which is the trade for keeping eight CVD-separable identities.
 *
 * Validated (adjacent pairs — the pairlist for lines and legend chips):
 *   node scripts/validate_palette.js "#4a3aa7,#e87ba4,#eda100,#008300,#2a78d6,#e34948,#1baf7a,#eb6834" \
 *     --mode light --surface "#ffffff"                 -> ALL CHECKS PASS
 *   node scripts/validate_palette.js "#9085e9,#d55181,#c98500,#008300,#3987e5,#e66767,#199e70,#d95926" \
 *     --mode dark  --surface "#131a24"                 -> ALL CHECKS PASS
 * Both carry a CVD warn in the 6-8 band, which is legal here because identity
 * never rests on colour alone: every picker wears its label (P1, P2, …) as a 3D
 * sprite and as text on its dashboard chip.
 */
export const AGENT_PALETTES: Record<ThemeMode, string[]> = {
  light: ['#4a3aa7', '#e87ba4', '#eda100', '#008300', '#2a78d6', '#e34948', '#1baf7a', '#eb6834'],
  dark: ['#9085e9', '#d55181', '#c98500', '#008300', '#3987e5', '#e66767', '#199e70', '#d95926'],
}

/** Read the preferred mode: stored choice first, then the OS setting. */
export function initialTheme(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    if (stored === 'light' || stored === 'dark') return stored
  } catch {
    // Private mode / storage disabled — fall through to the OS preference.
  }
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement
  root.dataset.theme = mode
  root.style.colorScheme = mode
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode)
  } catch {
    // Persistence is a nicety, not a requirement.
  }
}
