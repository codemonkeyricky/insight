import type { Counter } from "./shape.js";
import { makeCounter } from "./factory.js";

// Through a variable typed by the interface, which holds the factory's literal.
export function viaFactory(): number {
  const c = makeCounter();
  return c.bump();
}

// Through an interface-typed parameter: the class and every object literal are candidates.
export function viaParam(c: Counter): number {
  return c.bump();
}

// Array methods come from the lib, which the project does not index: no interface dispatch.
export function viaArray(): void {
  const xs: number[] = [];
  xs.push(1);
}
