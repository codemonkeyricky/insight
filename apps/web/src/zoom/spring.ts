// The camera's motion: one critically damped spring, stepped on a fixed clock. A move starts from the value and velocity
// the camera has now, so retargeting in flight (a key, a fling, a new fit) carries on smoothly, and any input can stop it
// where it is. Pure, so these rules are unit tested (test/spring.test.ts).

/** The spring's response in seconds: the time it takes to close most of the gap (critically damped). */
export const RESPONSE_S = 0.42;
/** The fixed integration rate. Frame time is carried over, so the motion does not depend on the display's refresh rate. */
export const SUBSTEP_HZ = 240;
/** Decay constant of a fling's momentum: a flick travels (v/1000) * MOMENTUM_DECAY / (1 - MOMENTUM_DECAY) pixels. */
export const MOMENTUM_DECAY = 0.998;

/** A spring's state: where it is, how fast it moves, and the frame time not yet integrated. */
export interface Spring {
  value: number;
  velocity: number;
  carry: number;
}

/** A spring at rest on `value`. */
export function restingAt(value: number): Spring {
  return { value, velocity: 0, carry: 0 };
}

/**
 * One fixed substep of a critically damped spring toward `target`: stiffness (2*pi/response)^2 and damping 2*sqrt(stiffness),
 * so the value closes on the target without overshooting. Semi-implicit Euler, which stays stable at 240 Hz.
 */
function substep(s: Spring, target: number, h: number, response: number): Spring {
  const w = (2 * Math.PI) / response;
  const accel = w * w * (target - s.value) - 2 * w * s.velocity;
  const velocity = s.velocity + accel * h;
  return { value: s.value + velocity * h, velocity, carry: 0 };
}

/**
 * Moves a spring toward `target` for `elapsed` seconds, in whole substeps of 1/SUBSTEP_HZ. The part of a substep left over is
 * kept in `carry` for the next call, so any frame rate integrates the same motion.
 */
export function advance(s: Spring, target: number, elapsed: number, response = RESPONSE_S): Spring {
  const h = 1 / SUBSTEP_HZ;
  let cur: Spring = { ...s, carry: s.carry + Math.max(0, elapsed) };
  while (cur.carry >= h) {
    cur = { ...substep(cur, target, h, response), carry: cur.carry - h };
  }
  return cur;
}

/** True when the spring is within `eps` of `target` and moving slower than `eps` per second: it can stop there. */
export function atRest(s: Spring, target: number, eps: number): boolean {
  return Math.abs(s.value - target) < eps && Math.abs(s.velocity) < eps;
}

/**
 * The distance a fling carries: its release speed in px/s projected with the decay constant. A flick at 1000 px/s travels
 * about 499 px. The spring starts from the release velocity and settles on this distance ahead of the release point.
 */
export function momentumOffset(v: number): number {
  return (v / 1000) * (MOMENTUM_DECAY / (1 - MOMENTUM_DECAY));
}

/** A pointer sample of a drag: when it was taken (ms) and the camera's translation then (px). */
export interface DragSample {
  t: number;
  x: number;
  y: number;
}

/**
 * The release velocity of a drag (px/s on each axis), from the samples taken in the last `windowMs` before `now`. A pause
 * before the release leaves nothing in the window, so a drag that stops dead does not fling.
 */
export function releaseVelocity(samples: readonly DragSample[], now: number, windowMs = 100): { vx: number; vy: number } {
  const recent = samples.filter((s) => now - s.t <= windowMs);
  const first = recent[0];
  const last = recent[recent.length - 1];
  if (first === undefined || last === undefined || last.t - first.t <= 0) return { vx: 0, vy: 0 };
  const dt = (last.t - first.t) / 1000;
  return { vx: (last.x - first.x) / dt, vy: (last.y - first.y) / dt };
}
