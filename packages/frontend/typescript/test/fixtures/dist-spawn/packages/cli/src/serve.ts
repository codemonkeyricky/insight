import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Mirrors packages/cli/src/serve.ts: the server is run from its build output, whose source is apps/server/src/main.ts.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const SERVER_MAIN = join(REPO_ROOT, "apps", "server", "dist", "main.js");

export function runServer(): void {
  spawn(process.execPath, [SERVER_MAIN], { stdio: "inherit" });
}
