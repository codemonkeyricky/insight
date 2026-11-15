import * as ns from "./state.js";
import { counter } from "./state.js";
export function bumpNs(): void {
  ns.counter++;
}
export function bumpDirect(): void {
  counter = counter + 1;
}
