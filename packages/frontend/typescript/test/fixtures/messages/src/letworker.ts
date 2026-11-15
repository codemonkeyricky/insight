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
