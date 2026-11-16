const state = { cache: new Map<string, number>(), inner: { n: 0 } };
const rows: { f: number }[] = [{ f: 0 }];

export function putDeep(): void {
  state.cache.set("a", 1);
}

export function setDeep(): void {
  state.inner.n = 2;
}

export function setElem(i: number): void {
  rows[i].f = 3;
}

export function neverWritten(): number {
  return state.inner.n;
}
