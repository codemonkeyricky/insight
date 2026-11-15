// A worker held in a `let` that is assigned after its declaration.
export function letAssigned(): void {
  let w: Worker | undefined;
  w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  w.postMessage({ seq: 3, n: 4 });
}

// A worker chosen by a ternary: either branch may hold the Worker.
export function ternaryPick(ready: boolean): void {
  const w: Worker | null = ready ? new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }) : null;
  w?.postMessage({ seq: 5, n: 6 });
}

// A worker that falls back to a new one when the first is missing.
export function nullishPick(cached: Worker | undefined): void {
  const w = cached ?? new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  w.postMessage({ seq: 7, n: 8 });
}

// A lazily made worker: `??=` and `||=` store the new Worker.
let lazy: Worker | undefined;
export function lazyNullish(): void {
  lazy ??= new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  lazy.postMessage({ seq: 9, n: 10 });
}

let lazyOr: Worker | undefined;
export function lazyOrAssign(): void {
  lazyOr ||= new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  lazyOr.postMessage({ seq: 11, n: 12 });
}

// A `var` declared in a block is scoped to its function: the assignment after the block counts.
export function varInBlock(c: boolean): void {
  if (c) {
    var v: Worker | undefined;
  }
  v = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  v.postMessage({ seq: 13, n: 14 });
}

// A self-referencing lazy init, used from many sites: each variable is expanded once, not once per reference.
let shared: Worker | undefined;
function getShared(): Worker {
  shared = shared ?? new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  shared = shared ?? new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  shared = shared ?? new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  shared = shared ?? new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  shared = shared ?? new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  shared = shared ?? new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  shared = shared ?? new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  shared = shared ?? new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  return shared;
}
export function useShared(): void {
  getShared();
  shared?.postMessage({ seq: 15, n: 16 });
  shared?.postMessage({ seq: 17, n: 18 });
  shared?.postMessage({ seq: 19, n: 20 });
  shared?.postMessage({ seq: 21, n: 22 });
  shared?.postMessage({ seq: 23, n: 24 });
}
