import { describe, expect, it } from "vitest";
import { RESPONSE_S, advance, atRest, momentumOffset, releaseVelocity, restingAt, SUBSTEP_HZ } from "../src/zoom/spring.js";

/** Runs a spring for `seconds` in frames of `frameS`, toward `target`, collecting every value it takes. */
function run(start: { value: number; velocity: number; carry: number }, target: number, seconds: number, frameS = 1 / 60) {
  let s = start;
  const values: number[] = [s.value];
  for (let t = 0; t < seconds - 1e-9; t += frameS) {
    s = advance(s, target, frameS);
    values.push(s.value);
  }
  return { s, values };
}

describe("critically damped spring", () => {
  it("converges on the target and comes to rest", () => {
    const { s } = run(restingAt(0), 100, 2);
    expect(Math.abs(s.value - 100)).toBeLessThan(1e-3);
    expect(atRest(s, 100, 0.01)).toBe(true);
  });

  it("does not overshoot the target when critically damped", () => {
    const { values } = run(restingAt(0), 100, 3);
    expect(Math.max(...values)).toBeLessThanOrEqual(100 + 1e-6);
    // The value only ever moves toward the target: no reversal once it has started.
    for (let i = 2; i < values.length; i++) {
      const a = values[i - 1] ?? 0;
      const b = values[i] ?? 0;
      const c = values[i - 2] ?? 0;
      expect(Math.sign(b - a) === 0 || Math.sign(b - a) === Math.sign(a - c) || Math.abs(b - a) < 1e-9).toBe(true);
    }
  });

  it("reaches about 95 percent of the way within roughly one response time", () => {
    const { values } = run(restingAt(0), 1, RESPONSE_S * 1.5);
    const at = values[Math.round((RESPONSE_S / (1 / 60)) * 1)] ?? 0;
    expect(at).toBeGreaterThan(0.6);
  });

  it("is independent of the frame rate, since time is integrated in fixed substeps", () => {
    const fast = run(restingAt(0), 50, 1, 1 / 120).s.value;
    const slow = run(restingAt(0), 50, 1, 1 / 30).s.value;
    expect(Math.abs(fast - slow)).toBeLessThan(1e-6);
  });

  it("keeps the frame time that is not a whole substep for the next call", () => {
    const h = 1 / SUBSTEP_HZ;
    const once = advance(restingAt(0), 1, h * 0.5);
    expect(once.value).toBe(0);
    expect(once.carry).toBeCloseTo(h * 0.5, 12);
    const twice = advance(once, 1, h * 0.5);
    expect(twice.value).not.toBe(0);
    expect(twice.carry).toBeLessThan(h);
  });

  it("can be interrupted: a retarget starts from the current value and velocity, with no jump", () => {
    const moving = advance(restingAt(0), 100, 0.15);
    expect(moving.velocity).toBeGreaterThan(0);
    // A retarget within one substep moves the value by at most one substep of its current velocity: no jump.
    const next = advance(moving, 0, 0.0001);
    expect(Math.abs(next.value - moving.value)).toBeLessThanOrEqual(Math.abs(moving.velocity) / SUBSTEP_HZ * 2 + 1e-9);
    expect(Math.sign(next.velocity)).toBe(Math.sign(moving.velocity) || 1);
    const { s } = run(next, 0, 3);
    expect(Math.abs(s.value)).toBeLessThan(1e-3);
  });

  it("starts from a release velocity (a fling) and settles on the projected distance", () => {
    const start = { value: 0, velocity: 800, carry: 0 };
    const target = momentumOffset(800);
    const { s } = run(start, target, 3);
    expect(Math.abs(s.value - target)).toBeLessThan(1e-3);
  });
});

describe("momentum", () => {
  it("projects a fling with the decay constant (v/1000) * 0.998 / (1 - 0.998)", () => {
    expect(momentumOffset(1000)).toBeCloseTo(0.998 / 0.002, 6);
    expect(momentumOffset(0)).toBe(0);
    expect(momentumOffset(-500)).toBeCloseTo(-momentumOffset(500), 9);
  });
});

describe("release velocity of a drag", () => {
  it("reads the speed over the last 100 ms of samples", () => {
    const samples = [
      { t: 0, x: 0, y: 0 },
      { t: 50, x: 20, y: -10 },
      { t: 100, x: 40, y: -20 },
    ];
    const v = releaseVelocity(samples, 100);
    expect(v.vx).toBeCloseTo(400, 6);
    expect(v.vy).toBeCloseTo(-200, 6);
  });

  it("gives no velocity when the drag stopped before the release", () => {
    const samples = [
      { t: 0, x: 0, y: 0 },
      { t: 20, x: 30, y: 0 },
    ];
    expect(releaseVelocity(samples, 400)).toEqual({ vx: 0, vy: 0 });
    expect(releaseVelocity([], 0)).toEqual({ vx: 0, vy: 0 });
  });
});
