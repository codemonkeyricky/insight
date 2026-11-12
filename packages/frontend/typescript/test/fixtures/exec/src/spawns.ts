import { fork } from "node:child_process";
import { Worker } from "node:worker_threads";

// A literal path is relative to the working directory: from the package root, ./src/crunch.js is src/crunch.ts once compiled.
export function literalWorker(): Worker {
  return new Worker("./src/crunch.js");
}

// The URL form names its script relative to this module.
export function urlWorker(): Worker {
  return new Worker(new URL("./crunch.js", import.meta.url));
}

// No such file in the project: the spawn keeps its target text and gets no edge.
export function missingWorker(): Worker {
  return new Worker("./src/missing.js");
}

export function childProcess(): void {
  fork("./src/child.js");
}

// A script that is not in the project: no edge.
export function missingChild(): void {
  fork("./src/absent.js");
}
