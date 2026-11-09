import { resolve } from "node:path";
import { runIndex } from "@insight/core";
import { formatReport } from "./format.js";

import { runServe, SERVE_USAGE } from "./serve.js";

const USAGE = `usage:
  insight index <path> [--state <dir>] [--full] [--allow-build-tools] [--json] [--quiet]
  insight serve [path...] [--port <n>] [--host <addr>] [--home <dir>] [--no-open]

  index    Extract IR for a project and write the snapshot, shards and SQLite index under <path>/.insight
  --state  Write the generated state to <dir> instead of <path>/.insight. Plugins and lens settings still come from <path>/.insight
  --full   Ignore cached shards and re-extract every file
  --allow-build-tools   Let frontends run build tools such as bazel or cmake (off by default)
  --json   Print the run report as JSON
  --quiet  Do not print progress lines

${SERVE_USAGE}`;

interface Args {
  command?: string;
  path?: string;
  /** The state folder, when --state is given. Undefined keeps the default, <path>/.insight. */
  state?: string;
  full: boolean;
  allowBuildTools: boolean;
  json: boolean;
  quiet: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { full: false, allowBuildTools: false, json: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--full") args.full = true;
    else if (a === "--allow-build-tools") args.allowBuildTools = true;
    else if (a === "--json") args.json = true;
    else if (a === "--quiet") args.quiet = true;
    else if (a === "--state") {
      const value = argv[++i];
      if (value === undefined || value === "" || value.startsWith("--")) throw new Error("--state needs a folder");
      args.state = value;
    }
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else if (args.command === undefined) args.command = a;
    else if (args.path === undefined) args.path = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  return args;
}

export async function main(argv: string[]): Promise<number> {
  if (argv[0] === "serve") return runServe(argv.slice(1));
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error((err as Error).message);
    console.error(USAGE);
    return 2;
  }
  if (args.command !== "index" || args.path === undefined) {
    console.error(USAGE);
    return 2;
  }
  const report = await runIndex({
    projectPath: resolve(args.path),
    ...(args.state !== undefined ? { stateDir: resolve(args.state) } : {}),
    full: args.full,
    allowBuildTools: args.allowBuildTools,
    onProgress: args.quiet || args.json ? undefined : (line) => console.error(line),
  });
  console.log(args.json ? JSON.stringify(report, null, 2) : formatReport(report));
  return report.problems.length > 0 ? 1 : 0;
}
