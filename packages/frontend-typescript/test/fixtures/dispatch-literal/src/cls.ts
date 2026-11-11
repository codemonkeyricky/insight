import type { Counter } from "./shape.js";

// A class implementing the same interface as the object literals.
export class Real implements Counter {
  bump(): number {
    return 4;
  }
}
