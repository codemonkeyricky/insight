import type { Counter } from "./shape.js";

// An object literal returned from a function declared to return the interface.
export function makeCounter(): Counter {
  return {
    bump(): number {
      return 1;
    },
  };
}
