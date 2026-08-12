/**
 * Icon set.
 *
 * One 16×16 grid, 1.5px strokes, `currentColor` throughout — so an icon inherits
 * the text colour of whatever it sits in and needs no per-theme handling. These
 * replace the glyph characters the chrome used to be built from (▶ ❙❙ ↺ ☰ ▤ ✕):
 * a font glyph renders at a different weight and baseline on every platform,
 * which is the fastest way to make an otherwise tidy interface look improvised.
 */
import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Icon({ size = 14, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

export function PlayIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.6 2.9 12.8 8l-8.2 5.1V2.9Z" fill="currentColor" stroke="none" />
    </Icon>
  )
}

export function PauseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="3" width="2.6" height="10" rx="0.8" fill="currentColor" stroke="none" />
      <rect x="9.4" y="3" width="2.6" height="10" rx="0.8" fill="currentColor" stroke="none" />
    </Icon>
  )
}

export function ResetIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13.4 8a5.4 5.4 0 1 1-1.9-4.1" />
      <path d="M13.6 1.9v3.2h-3.2" />
    </Icon>
  )
}

export function PanelLeftIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1.6" />
      <path d="M6.3 2.6v10.8" />
    </Icon>
  )
}

export function PanelRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1.6" />
      <path d="M9.7 2.6v10.8" />
    </Icon>
  )
}

export function SunIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="3.1" />
      <path d="M8 1.4v1.7M8 12.9v1.7M1.4 8h1.7M12.9 8h1.7M3.3 3.3l1.2 1.2M11.5 11.5l1.2 1.2M12.7 3.3l-1.2 1.2M4.5 11.5l-1.2 1.2" />
    </Icon>
  )
}

export function MoonIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13.2 10.4A5.6 5.6 0 0 1 5.6 2.8a5.6 5.6 0 1 0 7.6 7.6Z" />
    </Icon>
  )
}

export function CloseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Icon>
  )
}

/** Snap a detached card back onto the object it describes. */
export function SnapBackIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13.2 2.8 7.4 8.6" />
      <path d="M7.2 3.6h-3.8v3.8" />
      <path d="M9.4 13.2h3.4V9.8" />
    </Icon>
  )
}

/** Storage location. */
export function LocationIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 14.2s4.6-4 4.6-7.2a4.6 4.6 0 1 0-9.2 0C3.4 10.2 8 14.2 8 14.2Z" />
      <circle cx="8" cy="6.9" r="1.7" />
    </Icon>
  )
}

/** A case / unit of stock. */
export function BoxIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 1.9 14 5v6L8 14.1 2 11V5l6-3.1Z" />
      <path d="M2 5l6 3.1L14 5M8 8.1v6" />
    </Icon>
  )
}

export function WalkIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8.6" cy="2.6" r="1.5" />
      <path d="M8.4 5.4 6.6 8.2l1.9 1.6.7 4.3" />
      <path d="M8.5 9.8 5.6 14.1M8.4 5.6l2.6 1.5 1.4 2.1" />
    </Icon>
  )
}

export function ClockIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="6.1" />
      <path d="M8 4.5V8l2.6 1.7" />
    </Icon>
  )
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.2 8.6 6.2 11.6l6.6-7.2" />
    </Icon>
  )
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 3.6 10.4 8 6 12.4" />
    </Icon>
  )
}

export function AlertIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 2.4 14.4 13.4H1.6L8 2.4Z" />
      <path d="M8 6.4v3.1M8 11.6h.01" />
    </Icon>
  )
}

export function ExpandIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9.6 2.4h4v4M6.4 13.6h-4v-4" />
      <path d="M13.6 2.4 9.2 6.8M2.4 13.6l4.4-4.4" />
    </Icon>
  )
}

export function CollapseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13.2 6.8h-4v-4M2.8 9.2h4v4" />
      <path d="M9.2 6.8l4.4-4.4M6.8 9.2 2.4 13.6" />
    </Icon>
  )
}

export function InfoIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="6.1" />
      <path d="M8 7.2v4M8 4.9h.01" />
    </Icon>
  )
}

/** Shift set-up: fleet, pack-out and scene options. */
export function SlidersIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.4 4.6h11.2M2.4 11.4h11.2" />
      <circle cx="6" cy="4.6" r="1.7" />
      <circle cx="10.4" cy="11.4" r="1.7" />
    </Icon>
  )
}

/** Goods in: a delivery landing on the floor. */
export function InboundIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 2.2v6.6M5.3 6.2 8 8.9l2.7-2.7" />
      <path d="M2.6 10.6v2.2h10.8v-2.2" />
    </Icon>
  )
}

/** Goods out: a wave leaving the building. */
export function OutboundIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 9V2.4M5.3 5.1 8 2.4l2.7 2.7" />
      <path d="M2.6 10.6v2.2h10.8v-2.2" />
    </Icon>
  )
}

/** What already happened. */
export function HistoryIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.6 8a5.4 5.4 0 1 0 1.9-4.1" />
      <path d="M2.4 1.9v3.2h3.2" />
      <path d="M8 5.6V8l1.9 1.3" />
    </Icon>
  )
}

/** An open hand — steering the camera by pinch-and-move. */
export function HandIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5.6 8.4V3.6a1 1 0 0 1 2 0v3.8M7.6 7.2V2.9a1 1 0 0 1 2 0v4.3M9.6 7.4V3.7a1 1 0 0 1 2 0v5.1" />
      <path d="M11.6 8.6V6.1a1 1 0 0 1 2 0v4.3c0 2.5-1.7 4.4-4.1 4.4H8.2c-1.3 0-2-.4-2.8-1.4L3 9.9a1.1 1.1 0 0 1 1.6-1.5l1 .9" />
    </Icon>
  )
}

/** A closed hand — the "hold to rotate" gesture. */
export function FistIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.6" y="5.4" width="8.4" height="6.4" rx="2.4" />
      <path d="M3.6 8.4h8.4" />
      <path d="M2.6 7.1c-1 .3-1.4 1.5-.7 2.3l1.5 1.8" />
    </Icon>
  )
}

/** A point spinning around a centre — rotate/orbit. */
export function OrbitIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13.4 8A5.4 5.4 0 1 1 8 2.6" />
      <path d="M13.4 4.4V8h-3.6" />
      <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
    </Icon>
  )
}

/** A magnifier with a +/- gap — zoom in/out. */
export function ZoomIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="6.8" cy="6.8" r="4.4" />
      <path d="M4.6 6.8h4.4M11.8 11.8l2.4 2.4" />
    </Icon>
  )
}

/** One finger extended, the rest curled — the "select an object" gesture. */
export function PointIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.4" y="7.6" width="7.4" height="5.2" rx="2.1" />
      <path d="M6.2 7.8V3.3a1 1 0 0 1 2 0v4.3" />
      <path d="M2.4 9.9c-.9.3-1.2 1.3-.6 2l1.4 1.6" />
    </Icon>
  )
}

/** Thumb and index tip together — the "interact with the target" gesture. */
export function PinchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="6" cy="6.2" r="1.5" />
      <circle cx="9.6" cy="9" r="1.5" />
      <path d="M11.4 4.4c1.1.4 1.9 1.3 2.2 2.4M13.6 9.4c-.2 1.2-1 2.2-2 2.8" />
    </Icon>
  )
}

/** Index and middle fingers held together, the rest curled — the two-finger
 *  drag/pan gesture, same shape used to scroll on a touchpad or phone. */
export function TwoFingerIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.6" y="7.6" width="9.2" height="5.4" rx="2.4" />
      <path d="M5.2 7.8V3a1 1 0 0 1 2 0v4.4M7.6 7.6V2.6a1 1 0 0 1 2 0v5" />
      <path d="M1.6 9.9c-.9.3-1.2 1.3-.6 2l1.4 1.6" />
    </Icon>
  )
}

/** Two hands spreading apart — zoom and 360° rotation together. */
export function TwoHandIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="5.6" cy="8" r="2.1" />
      <circle cx="10.4" cy="8" r="2.1" />
      <path d="M1.6 8h1M13.4 8h1" />
      <path d="M1.6 8 3 6.8M1.6 8 3 9.2M14.4 8 13 6.8M14.4 8 13 9.2" />
    </Icon>
  )
}

/** The product mark: two racking bays. */
export function RackMarkIcon({ size = 18, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      {...rest}
    >
      <path d="M2.5 14.5V6l3.2-2 3.2 2v8.5M9 14.5V8.4l3.2-2 3.2 2v6.1M2.5 10.2h6.4M9 11.6h6.4" />
    </svg>
  )
}
