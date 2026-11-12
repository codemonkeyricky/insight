import type { Counter } from "./shape.js";

// An object literal assigned to an interface-annotated variable.
export const annotated: Counter = {
  bump(): number {
    return 2;
  },
};

// An object literal checked against the interface with satisfies.
export const sat = {
  bump(): number {
    return 3;
  },
} satisfies Counter;
