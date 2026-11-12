import { execFileSync } from "node:child_process";
import { Worker } from "node:worker_threads";

export function gitHead(dir: string): string {
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

export function startWorker(): Worker {
  return new Worker("./worker.js");
}

export function* countTo(n: number): Generator<number> {
  for (let i = 0; i < n; i++) yield i;
}
