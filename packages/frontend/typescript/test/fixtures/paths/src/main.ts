import { fork } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

// File-relative: a new URL of a literal, resolved against import.meta.url. Exact.
export function urlForm(): Worker {
  return new Worker(new URL("./worker.js", import.meta.url));
}

// File-relative: join of import.meta.dirname and a literal segment. Exact.
export function joinForm(): Worker {
  return new Worker(join(import.meta.dirname, "worker.js"));
}

// File-relative: a template over __dirname with a literal tail. Exact.
export function templateForm(): Worker {
  return new Worker(`${__dirname}/worker.js`);
}

// File-relative: fileURLToPath of a file URL, forked. Exact.
export function fileUrlForm(): void {
  fork(fileURLToPath(new URL("./child.js", import.meta.url)));
}

// Cwd-relative literal: heuristic, from the package root.
export function literalForm(): Worker {
  return new Worker("./src/worker.js");
}

// The compiler writes src/worker.ts to dist/worker.js, so this maps back to the source. Inferred.
export function outputForm(): Worker {
  return new Worker("./dist/worker.js");
}

// Absolute path: names no project file, so no edge.
export function absoluteForm(): Worker {
  return new Worker("/usr/share/worker.js");
}

// A computed path: nothing is known statically, so no edge.
export function computedForm(name: string): Worker {
  return new Worker(name);
}

// A literal fork target, relative to the working directory.
export function forkLiteral(): void {
  fork("./src/child.js");
}
