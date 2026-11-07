import { resolve } from "node:path";
import { runIndex } from "@insight/core";
import { formatReport } from "./format.js";

const USAGE = `usage: insight index <path> [--full] [--allow-build-tools] [--json] [--quiet]

  index    Extract IR for a project and write the snapshot, shards and SQLite index under <path>/.insight
  --full   Ignore cached shards and re-extract every file
  --allow-build-tools   Let frontends run build tools such as bazel or cmake (off by default)
  --json   Print the run report as JSON
  --quiet  Do not print progress lines`;

interface Args {
  command?: string;
  path?: string;
  full: boolean;
  allowBuildTools: boolean;
  json: boolean;
  quiet: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { full: false, allowBuildTools: false, json: false, quiet: false };
  for (const a of argv) {
    if (a === "--full") args.full = true;
    else if (a === "--allow-build-tools") args.allowBuildTools = true;
    else if (a === "--json") args.json = true;
    else if (a === "--quiet") args.quiet = true;
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else if (args.command === undefined) args.command = a;
    else if (args.path === undefined) args.path = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  return args;
}

export async function main(argv: string[]): Promise<number> {
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
    full: args.full,
    allowBuildTools: args.allowBuildTools,
    onProgress: args.quiet || args.json ? undefined : (line) => console.error(line),
  });
  console.log(args.json ? JSON.stringify(report, null, 2) : formatReport(report));
  return report.problems.length > 0 ? 1 : 0;
}
