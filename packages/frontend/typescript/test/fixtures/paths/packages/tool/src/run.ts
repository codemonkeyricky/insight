import { Worker } from "node:worker_threads";

// Cwd-relative literal: from the nearest package, which holds w.js at its root. Heuristic.
export function pkgRoot(): Worker {
  return new Worker("./w.js");
}

// File-relative URL: the w.js beside this file, in src. Exact.
export function sameDir(): Worker {
  return new Worker(new URL("./w.js", import.meta.url));
}

// Cwd-relative into the package's src: from the nearest package. Heuristic.
export function pkgSrc(): Worker {
  return new Worker("./src/w.js");
}

// Cwd-relative with no such file in the package: falls back to the project root. Heuristic.
export function rootFallback(): Worker {
  return new Worker("./src/worker.js");
}
