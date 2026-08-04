/** @type {import('tailwindcss').Config} */
export default {
  // Themes are driven by [data-theme] on <html>, set in src/ui/theme.ts.
  darkMode: ['selector', '[data-theme="dark"]'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Background -> foreground ramp; see the header comment in src/index.css.
        // Channel triplets so `/NN` opacity modifiers work on every step.
        ink: {
          950: 'rgb(var(--ink-950) / <alpha-value>)',
          900: 'rgb(var(--ink-900) / <alpha-value>)',
          850: 'rgb(var(--ink-850) / <alpha-value>)',
          800: 'rgb(var(--ink-800) / <alpha-value>)',
          750: 'rgb(var(--ink-750) / <alpha-value>)',
          700: 'rgb(var(--ink-700) / <alpha-value>)',
          600: 'rgb(var(--ink-600) / <alpha-value>)',
          500: 'rgb(var(--ink-500) / <alpha-value>)',
          400: 'rgb(var(--ink-400) / <alpha-value>)',
          300: 'rgb(var(--ink-300) / <alpha-value>)',
          200: 'rgb(var(--ink-200) / <alpha-value>)',
          100: 'rgb(var(--ink-100) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          soft: 'rgb(var(--accent-soft) / <alpha-value>)',
          deep: 'rgb(var(--accent-deep) / <alpha-value>)',
        },
        good: 'rgb(var(--good-rgb) / <alpha-value>)',
        warn: 'rgb(var(--warn-rgb) / <alpha-value>)',
        crit: 'rgb(var(--crit-rgb) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      boxShadow: {
        panel: 'var(--shadow-panel)',
        float: 'var(--shadow-float)',
        glow: '0 0 0 1px rgb(var(--accent) / 0.35), 0 0 24px -6px rgb(var(--accent) / 0.4)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0', transform: 'translateY(4px)' }, to: { opacity: '1', transform: 'none' } },
      },
      animation: {
        'fade-in': 'fade-in 160ms ease-out both',
      },
    },
  },
  plugins: [],
}
