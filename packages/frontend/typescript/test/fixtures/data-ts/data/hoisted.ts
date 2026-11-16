function makeState(): { loads: number } {
  return { loads: 0 };
}
// Bound to a call result and written through a property: mutable state.
const s = makeState();
export function load(): void {
  s.loads++;
}
// Bound to a call result and only read: not state.
const r = makeState();
export function reading(): number {
  return r.loads;
}
