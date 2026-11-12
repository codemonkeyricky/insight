import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SERVE_USAGE = `usage: insight serve [path...] [--port <n>] [--host <addr>] [--home <dir>] [--no-open]

  serve      Start the Insight server with the web app, and register each path as a project
  path       A folder to index. Repeat for more. A folder that is already registered is left as it is
  --port     Port to listen on (default 4317)
  --host     Address to listen on (default 127.0.0.1)
  --home     Folder for the project registry and the state of registered projects (default INSIGHT_HOME, else ~/.insight)
  --no-open  Do not open the browser`;

export interface ServeArgs {
  /** Absolute paths of the folders to register as projects. */
  paths: string[];
  port: number;
  host: string;
  home?: string;
  open: boolean;
}

/** Parses the arguments after `insight serve`. Each path is resolved to an absolute path. Throws on bad input. */
export function parseServeArgs(argv: string[]): ServeArgs {
  const args: ServeArgs = { paths: [], port: 4317, host: "127.0.0.1", open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--no-open") {
      args.open = false;
    } else if (a === "--port" || a === "--host" || a === "--home") {
      const value = argv[++i];
      if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`${a} needs a value`);
      if (a === "--port") {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--port must be a port number, got ${value}`);
        args.port = port;
      } else if (a === "--host") {
        args.host = value;
      } else {
        args.home = value;
      }
    } else if (a.startsWith("--")) {
      throw new Error(`unknown option ${a}`);
    } else {
      args.paths.push(resolve(a));
    }
  }
  return args;
}

/**
 * Whether to open a browser. Never when the output is not a terminal. On Linux, only when a display is set, so
 * a headless shell does not try to open one.
 */
export function shouldOpenBrowser(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, isTTY: boolean): boolean {
  if (!isTTY) return false;
  if (platform === "linux") return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
  return true;
}

/** The command that opens a URL in the default browser on this platform, or undefined when there is none. */
export function openCommand(url: string, platform: NodeJS.Platform): { cmd: string; args: string[] } | undefined {
  if (platform === "darwin") return { cmd: "open", args: [url] };
  if (platform === "win32") return { cmd: "cmd", args: ["/c", "start", "", url] };
  if (platform === "linux") return { cmd: "xdg-open", args: [url] };
  return undefined;
}

const HERE = dirname(fileURLToPath(import.meta.url));
/** The repository root: apps/cli/dist -> the repo. */
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const SERVER_MAIN = join(REPO_ROOT, "apps", "server", "dist", "main.js");
const WEB_INDEX = join(REPO_ROOT, "apps", "web", "dist", "index.html");
const BUILD_HINT = "The web app or server is not built. Run: pnpm install && pnpm -r --workspace-concurrency=1 build";

function openBrowser(url: string): void {
  const command = openCommand(url, process.platform);
  if (!command) return;
  const child = spawn(command.cmd, command.args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Polls the server until it answers, or until it exits or the wait runs out. */
async function waitForHealth(base: string, child: ChildProcess, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the server stopped with code ${child.exitCode}`);
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    await sleep(200);
  }
  throw new Error(`the server did not answer at ${base} within ${timeoutMs / 1000} seconds`);
}

/** Registers a folder as a project. A folder that is already registered is not an error. */
async function register(base: string, path: string): Promise<"added" | "present"> {
  const res = await fetch(`${base}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (res.status === 201) return "added";
  if (res.status === 409) return "present";
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error ?? `HTTP ${res.status}`);
}

/**
 * Starts the server with the built web app, registers the given folders, prints the address and opens the browser.
 * The server runs as its own process so the same server code serves the CLI and `pnpm start`.
 */
export async function runServe(argv: string[]): Promise<number> {
  let args: ServeArgs;
  try {
    args = parseServeArgs(argv);
  } catch (err) {
    console.error((err as Error).message);
    console.error(SERVE_USAGE);
    return 2;
  }
  if (!existsSync(WEB_INDEX) || !existsSync(SERVER_MAIN)) {
    console.error(BUILD_HINT);
    return 1;
  }
  for (const p of args.paths) {
    if (!existsSync(p)) {
      console.error(`path does not exist: ${p}`);
      return 1;
    }
  }

  const home = args.home ? resolve(args.home) : resolve(process.env.INSIGHT_HOME ?? join(homedir(), ".insight"));
  const env = { ...process.env, PORT: String(args.port), HOST: args.host, INSIGHT_HOME: home };
  const child = spawn(process.execPath, [SERVER_MAIN], { env, stdio: "inherit" });
  const exited = new Promise<number>((done) => {
    child.once("exit", (code, signal) => done(code ?? (signal ? 1 : 0)));
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      if (child.exitCode === null) child.kill(sig);
    });
  }

  const base = `http://${args.host === "0.0.0.0" ? "127.0.0.1" : args.host}:${args.port}`;
  try {
    await waitForHealth(base, child);
    for (const p of args.paths) {
      const outcome = await register(base, p);
      console.log(outcome === "added" ? `added project ${p}` : `already a project: ${p}`);
    }
    console.log(`Insight is running at ${base}  (home: ${home})`);
    console.log("Press Ctrl+C to stop.");
    if (args.open && shouldOpenBrowser(process.env, process.platform, Boolean(process.stdout.isTTY))) openBrowser(base);
    return await exited;
  } catch (err) {
    console.error((err as Error).message);
    if (child.exitCode === null) child.kill("SIGTERM");
    await exited;
    return 1;
  }
}
