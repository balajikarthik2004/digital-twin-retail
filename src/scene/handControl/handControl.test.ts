import type { NormalizedLandmark } from '@mediapipe/tasks-vision'
import { describe, expect, it } from 'vitest'
import { HandControlManager } from './HandControlManager'
import { DEAD_ZONE, MAX_REACH, NavigationController } from './NavigationController'
import { PINCH_ARM_MS, ROTATE_DRAG_SCALE } from './PinchRotateController'
import { ZERO_INTENT } from './types'
import { ZoomController } from './ZoomController'

/**
 * Gesture arbitration, driven by synthetic hands.
 *
 * These are geometric fixtures, not recordings: a hand here is 21 landmarks
 * placed so the detectors in `GestureDetector` read exactly one shape from it,
 * with the thumb parked at a chosen palm-normalized distance from the index tip
 * so `pinchRatio` comes out at whatever the test needs. That is enough to
 * exercise the whole decision — the manager only ever sees landmarks.
 *
 * The cases to care about are the collisions: pinch-hold rotate shares a hand
 * pose with zoom (a shut pinch is the closed end of zoom's range) and shares
 * an outcome with fist rotate (whose curled thumb measures as a pinch). Both
 * are asserted here, because both fail *silently* if the priority order slips —
 * the camera just starts doing two things at once.
 */

const FRAME_MS = 1000 / 30

/** Wrist to middle-finger MCP — what `pinchRatio` normalizes against. */
const PALM = 0.2

interface Pt {
  x: number
  y: number
}

function toLandmarks(points: Pt[], dx: number, dy: number): NormalizedLandmark[] {
  return points.map((p) => ({ x: p.x + dx, y: p.y + dy, z: 0, visibility: 1 }))
}

/** MCP, PIP, DIP, TIP for one finger. Curled tips fold back level with the
 *  knuckle, which reads as a ~0° bend at the PIP; extended ones reach straight
 *  out, ~180°. */
function finger(x: number, curled: boolean): Pt[] {
  const tipY = curled ? 0.5 : 0.34
  return [
    { x, y: 0.5 },
    { x, y: 0.42 },
    { x, y: (0.42 + tipY) / 2 },
    { x, y: tipY },
  ]
}

/** CMC, MCP, IP, TIP for a thumb whose tip sits at `tip`. Extended lays the
 *  chain out straight; curled kinks it at the IP. */
function thumb(tip: Pt, curled: boolean): Pt[] {
  if (curled) {
    return [
      { x: tip.x + 0.15, y: tip.y + 0.02 },
      { x: tip.x + 0.1, y: tip.y },
      { x: tip.x + 0.05, y: tip.y - 0.06 },
      tip,
    ]
  }
  return [
    { x: tip.x + 0.24, y: tip.y + 0.24 },
    { x: tip.x + 0.16, y: tip.y + 0.16 },
    { x: tip.x + 0.08, y: tip.y + 0.08 },
    tip,
  ]
}

interface PoseSpec {
  /** Target `pinchRatio`: thumb-to-index-tip distance in palm widths. */
  pinch: number
  index: boolean
  middle: boolean
  ring: boolean
  pinky: boolean
  thumbCurled: boolean
}

function pose(spec: PoseSpec, dx = 0, dy = 0): NormalizedLandmark[][] {
  const index = finger(0.46, !spec.index)
  const middle = finger(0.5, !spec.middle)
  const ring = finger(0.54, !spec.ring)
  const pinky = finger(0.58, !spec.pinky)
  const indexTip = index[3]
  const thumbTip = { x: indexTip.x + spec.pinch * PALM, y: indexTip.y }
  const points: Pt[] = [
    { x: 0.5, y: 0.7 }, // wrist — PALM below the middle MCP at (0.5, 0.5)
    ...thumb(thumbTip, spec.thumbCurled),
    ...index,
    ...middle,
    ...ring,
    ...pinky,
  ]
  return [toLandmarks(points, dx, dy)]
}

/** Index out, the other three curled, thumb free — the `point` shape both zoom
 *  and the pinch hold live inside. `pinch` picks which of the two. */
const pinchHand = (pinch: number, dx = 0, dy = 0) =>
  pose({ pinch, index: true, middle: false, ring: false, pinky: false, thumbCurled: false }, dx, dy)

/** Everything curled, thumb included — and deliberately built so its thumb tip
 *  lands right beside the folded index tip, i.e. it *measures* as a shut pinch.
 *  The adversarial case for the shape gate on arming. */
const fistHand = (dx = 0, dy = 0) =>
  pose({ pinch: 0.2, index: false, middle: false, ring: false, pinky: false, thumbCurled: true }, dx, dy)

/** Index + middle out, ring + pinky curled — the pan shape, likewise given a
 *  shut-pinch thumb so pan's precedence over arming is actually tested. */
const twoFingerHand = (dx = 0, dy = 0) =>
  pose({ pinch: 0.2, index: true, middle: true, ring: false, pinky: false, thumbCurled: false }, dx, dy)

/** Feeds frames on a clock the test owns, at a realistic 30fps. */
class Rig {
  private manager = new HandControlManager()
  private now = 0

  step(hands: NormalizedLandmark[][]) {
    this.now += FRAME_MS
    return this.manager.handleGesture(hands, this.now)
  }

  /** Holds a pose for `ms` and returns the last frame's result. */
  hold(hands: NormalizedLandmark[][], ms: number) {
    const until = this.now + ms
    let last = this.step(hands)
    while (this.now < until) last = this.step(hands)
    return last
  }
}

describe('hand shapes', () => {
  it('reads each fixture as the one shape it was built for', () => {
    const rig = new Rig()
    expect(rig.hold(pinchHand(1.2), 200).snapshot.hands[0].shape).toBe('point')
    expect(new Rig().hold(fistHand(), 200).snapshot.hands[0].shape).toBe('fist')
    expect(new Rig().hold(twoFingerHand(), 200).snapshot.hands[0].shape).toBe('twoFinger')
  })
})

describe('pinch-and-hold to rotate', () => {
  it('does nothing but count while the hold is short of two seconds', () => {
    const rig = new Rig()
    const held = rig.hold(pinchHand(0.2), PINCH_ARM_MS * 0.5)

    expect(held.snapshot.mode).toBe('idle')
    // Critically, zoom is suppressed too: waiting out the hold must not dolly
    // the camera, or the two gestures would cancel each other out.
    expect(held.intent).toEqual(ZERO_INTENT)
    expect(held.snapshot.armProgress).toBeGreaterThan(0.35)
    expect(held.snapshot.armProgress).toBeLessThan(1)
    expect(held.snapshot.message).toMatch(/rotate in \d\.\ds/)
  })

  it('arms after two seconds, and starts from rest wherever the hand is', () => {
    const rig = new Rig()
    const armed = rig.hold(pinchHand(0.2), PINCH_ARM_MS + 200)

    expect(armed.snapshot.mode).toBe('rotate')
    expect(armed.snapshot.armProgress).toBe(1)
    // Reference captured at the instant it armed, so the handover cannot snap
    // the view even if the hand armed far off-centre.
    expect(armed.intent.orbitYaw).toBe(0)
    expect(armed.intent.orbitPitch).toBe(0)
    expect(armed.intent.zoom).toBe(0)
  })

  it('turns while the hand is held off-centre, and keeps turning', () => {
    const rig = new Rig()
    rig.hold(pinchHand(0.2), PINCH_ARM_MS + 200)

    const moved = rig.hold(pinchHand(0.2, -0.35, 0), 500)
    expect(moved.snapshot.mode).toBe('rotate')
    // Full reach -> the full rate, which is what puts a 360° turn within a
    // couple of seconds of hand-holding rather than a dozen re-grabs.
    expect(moved.intent.orbitYaw).toBeCloseTo(ROTATE_DRAG_SCALE, 5)

    // A held rate, not a one-shot delta: three more seconds of the same hand
    // position is three more seconds of turning at the same speed.
    const later = rig.hold(pinchHand(0.2, -0.35, 0), 3000)
    expect(later.intent.orbitYaw).toBeCloseTo(moved.intent.orbitYaw, 5)

    // And the other way for the other side.
    const back = rig.hold(pinchHand(0.2, 0.35, 0), 500)
    expect(back.intent.orbitYaw).toBeCloseTo(-ROTATE_DRAG_SCALE, 5)
  })

  it('turns the camera exactly the way a fist does, for the same drag', () => {
    const pinchRig = new Rig()
    pinchRig.hold(pinchHand(0.2), PINCH_ARM_MS + 200)
    const byPinch = pinchRig.hold(pinchHand(0.2, -0.2, 0.12), 500).intent

    const fistRig = new Rig()
    fistRig.hold(fistHand(), 300)
    const byFist = fistRig.hold(fistHand(-0.2, 0.12), 500).intent

    expect(byPinch.orbitYaw).toBeCloseTo(byFist.orbitYaw, 6)
    expect(byPinch.orbitPitch).toBeCloseTo(byFist.orbitPitch, 6)
    expect(byPinch.orbitPitch).not.toBe(0)
  })

  it('stops the moment the fingers open, and makes you hold again to resume', () => {
    const rig = new Rig()
    rig.hold(pinchHand(0.2), PINCH_ARM_MS + 200)
    expect(rig.hold(pinchHand(0.2, -0.35, 0), 500).snapshot.mode).toBe('rotate')

    const released = rig.hold(pinchHand(1.2, -0.35, 0), 200)
    expect(released.snapshot.mode).not.toBe('rotate')
    expect(released.intent.orbitYaw).toBe(0)
    expect(released.intent.orbitPitch).toBe(0)

    // Re-pinching does not resume rotation on the old timer.
    const rePinched = rig.hold(pinchHand(0.2, -0.35, 0), 500)
    expect(rePinched.snapshot.mode).toBe('idle')
    expect(rePinched.intent.orbitYaw).toBe(0)
  })

  it('drops rotate when the hand leaves frame', () => {
    const rig = new Rig()
    rig.hold(pinchHand(0.2), PINCH_ARM_MS + 200)
    rig.hold(pinchHand(0.2, -0.35, 0), 500)

    const gone = rig.step([])
    expect(gone.snapshot.status).toBe('no-hand')
    expect(gone.intent).toEqual(ZERO_INTENT)

    // ...and the hold starts over when it comes back.
    expect(rig.hold(pinchHand(0.2), 500).snapshot.mode).toBe('idle')
  })
})

describe('gestures do not collide', () => {
  it('still zooms across the open half of the pinch range', () => {
    const rig = new Rig()
    expect(rig.hold(pinchHand(0.75), 300).snapshot.mode).toBe('zoom')

    // Spreading the tips wider is zoom-in, unchanged by the rotate hold living
    // at the closed end.
    const spreading = rig.step(pinchHand(1.6))
    expect(spreading.snapshot.mode).toBe('zoom')
    expect(spreading.intent.zoom).toBeGreaterThan(0)
    expect(spreading.intent.orbitYaw).toBe(0)
    expect(spreading.intent.orbitPitch).toBe(0)
  })

  it('never zooms while a pinch is shut, armed or arming', () => {
    const rig = new Rig()
    expect(rig.hold(pinchHand(0.2), 1000).intent.zoom).toBe(0)
    expect(rig.hold(pinchHand(0.2), PINCH_ARM_MS).intent.zoom).toBe(0)
    expect(rig.hold(pinchHand(0.2, -0.35, 0), 500).intent.zoom).toBe(0)
  })

  it('does not let a fist arm a pinch hold behind its own rotate', () => {
    const rig = new Rig()
    rig.hold(fistHand(), 300)
    const early = rig.hold(fistHand(-0.35, 0), 500)

    // Well past the dwell — if the fist's pinch-like thumb could arm the hold,
    // it would take over here and snap the view as the reference reset.
    const late = rig.hold(fistHand(-0.35, 0), PINCH_ARM_MS + 2000)
    expect(late.snapshot.mode).toBe('rotate')
    expect(late.snapshot.armProgress).toBe(0)
    expect(late.intent.orbitYaw).toBeCloseTo(early.intent.orbitYaw, 6)
  })

  it('keeps panning a two-finger drag no matter how long it is held', () => {
    const rig = new Rig()
    rig.hold(twoFingerHand(), 300)
    const panning = rig.hold(twoFingerHand(-0.35, 0), PINCH_ARM_MS + 2000)

    expect(panning.snapshot.mode).toBe('pan')
    expect(panning.intent.pan.right).toBeGreaterThan(0)
    expect(panning.intent.orbitYaw).toBe(0)
    expect(panning.intent.orbitPitch).toBe(0)
    expect(panning.intent.zoom).toBe(0)
  })

  it('only ever drives one channel in a frame', () => {
    const rig = new Rig()
    const frames = [
      rig.hold(pinchHand(1.2), 200),
      rig.step(pinchHand(1.6)),
      rig.hold(pinchHand(0.2), PINCH_ARM_MS + 200),
      rig.hold(pinchHand(0.2, -0.3, 0.1), 300),
      rig.hold(twoFingerHand(-0.3, 0), 300),
      rig.hold(fistHand(-0.3, 0), 300),
      rig.step([]),
    ]

    for (const { intent } of frames) {
      const live = [
        intent.pan.right !== 0 || intent.pan.up !== 0 || intent.pan.forward !== 0,
        intent.orbitYaw !== 0 || intent.orbitPitch !== 0,
        intent.zoom !== 0,
      ].filter(Boolean)
      expect(live.length).toBeLessThanOrEqual(1)
    }
  })
})

describe('zoom smoothing', () => {
  it('never zooms on the first frame, so engaging the gesture cannot snap the camera', () => {
    expect(new ZoomController().drive(0.4)).toBe(0)
  })

  it('accumulates a slow spread instead of discarding it frame by frame', () => {
    // Each individual step is under the noise floor. A controller that consumed
    // its reference every frame would swallow all of them and never zoom, which
    // is precisely what makes fine, deliberate placement impossible.
    const z = new ZoomController()
    z.drive(0.4)
    let total = 0
    for (let i = 1; i <= 12; i++) total += z.drive(0.4 + i * 0.0015)
    expect(total).toBeGreaterThan(0)
  })

  it('holds still for pure jitter around a fixed pinch', () => {
    const z = new ZoomController()
    z.drive(0.4)
    let total = 0
    for (let i = 0; i < 40; i++) total += z.drive(0.4 + (i % 2 === 0 ? 0.0008 : -0.0008))
    expect(Math.abs(total)).toBeLessThan(0.01)
  })

  it('is continuous through the noise floor rather than stepping over it', () => {
    // A hard cut-off would jump straight to the full delta the moment it
    // cleared; the soft knee means the first movement that registers is small.
    const z = new ZoomController()
    z.drive(0.4)
    const justOver = z.drive(0.4 * (1 / (1 - 0.0055)))
    expect(justOver).toBeGreaterThan(0)
    expect(justOver).toBeLessThan(0.002)
  })

  it('clamps a mistracked frame so a lost hand cannot fling the camera', () => {
    const z = new ZoomController()
    z.drive(0.4)
    // Pinch distance triples in one frame — a hand half out of the frame.
    expect(Math.abs(z.drive(1.2))).toBeLessThanOrEqual(0.06)
  })

  it('spreading apart zooms in and closing zooms out', () => {
    const wide = new ZoomController()
    wide.drive(0.3)
    expect(wide.drive(0.36)).toBeGreaterThan(0)

    const narrow = new ZoomController()
    narrow.drive(0.36)
    expect(narrow.drive(0.3)).toBeLessThan(0)
  })

  it('forgets its reference on reset, so re-engaging never jumps', () => {
    const z = new ZoomController()
    z.drive(0.2)
    z.reset()
    expect(z.drive(0.9)).toBe(0)
  })
})

describe('pan tracking ramp', () => {
  const at = (dx: number) => {
    const nav = new NavigationController()
    nav.engage({ x: 0.5, y: 0.5 })
    return nav.drive({ x: 0.5 + dx, y: 0.5 }, 1).right
  }

  it('ignores drift inside the dead zone', () => {
    expect(at(DEAD_ZONE * 0.9)).toBe(0)
  })

  it('eases in, so the first movement past the dead zone is gentle', () => {
    // Where the hand is least steady, a linear ramp is at its twitchiest. Just
    // past the threshold the response should still be a fraction of the
    // linear reading, not equal to it.
    const justPast = (DEAD_ZONE + MAX_REACH) / 2 - (MAX_REACH - DEAD_ZONE) * 0.4
    const linear = (justPast - DEAD_ZONE) / (MAX_REACH - DEAD_ZONE)
    expect(at(justPast)).toBeLessThan(linear)
  })

  it('still reaches full deflection at full reach, and clamps beyond it', () => {
    expect(at(MAX_REACH)).toBeCloseTo(1)
    expect(at(MAX_REACH * 3)).toBeCloseTo(1)
  })

  it('is symmetric about the reference point', () => {
    expect(at(-0.2)).toBeCloseTo(-at(0.2))
  })
})
