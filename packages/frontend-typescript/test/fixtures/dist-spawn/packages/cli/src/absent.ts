import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// A build output with no source counterpart in the project: no spawns edge.
const ABSENT_MAIN = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "apps", "server", "dist", "absent.js");

export function runAbsent(): void {
  spawn(process.execPath, [ABSENT_MAIN]);
}

// A command that is not a Node binary runs no project script: no spawns edge.
export function gitHead(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
}
