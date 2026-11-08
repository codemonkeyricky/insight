import { join } from "node:path";
import { Worker } from "node:worker_threads";

// File-relative from a subdirectory: .. climbs to src, where worker.ts is. Exact.
export function viaUrl(): Worker {
  return new Worker(new URL("../worker.js", import.meta.url));
}

// File-relative: join of import.meta.dirname and a parent segment. Exact.
export function viaJoin(): Worker {
  return new Worker(join(import.meta.dirname, "..", "worker.js"));
}
