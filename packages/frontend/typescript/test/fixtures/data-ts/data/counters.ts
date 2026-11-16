let hits = 0;
export let total = 0;
const snapshot = hits;
export function bump(): void {
  hits++;
}
export function show(): number {
  return hits;
}
export function shadow(): number {
  let hits = 5;
  hits++;
  return hits;
}
export function addTotal(): void {
  total += 1;
}
export { snapshot };
export const initial = show();
