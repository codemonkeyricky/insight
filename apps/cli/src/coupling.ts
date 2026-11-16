import { resolve } from "node:path";
import { loadState, projectPaths, readSnapshot } from "@insight/indexer";
import { couplingIndex, couplingReport, type CouplingReport } from "@insight/flow";
import type { IREdge, IRNode } from "@insight/ir";
import { formatCoupling } from "./format.js";

export interface CouplingArgs {
  /** A function id, a file path, or a folder prefix. `.` or the empty string is the whole project. */
  selector: string;
  /** The project folder. Defaults to the current directory. */
  project?: string;
  /** The state folder. Defaults to `<project>/.insight`. */
  state?: string;
  /** Print exactly the JSON the HTTP route answers, instead of the text summary. */
  json: boolean;
}

/** A scope path with `\` as `/`, no empty or `.` segments. */
function scopeOf(selector: string): string {
  return selector
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
}

/**
 * `insight coupling <fn|file|scope>`: read an existing snapshot, build its coupling index, and print the report of one
 * function, one file, a folder prefix, or the whole project. It never indexes: without a snapshot it says so and exits 1,
 * so an agent never waits on a silent full index. `--json` prints the route's bytes (`JSON.stringify(report)`).
 */
export async function runCoupling(args: CouplingArgs): Promise<number> {
  const root = resolve(args.project ?? ".");
  const paths = projectPaths(root, args.state !== undefined ? resolve(args.state) : undefined);
  const state = loadState(paths);
  const snapshot = state.latest ?? state.snapshots.at(-1)?.id;
  if (snapshot === undefined) {
    console.error(`no snapshot in ${paths.state}; index the project first: insight index ${root}`);
    return 1;
  }
  let records;
  try {
    records = readSnapshot(paths, snapshot);
  } catch (err) {
    console.error(`cannot read snapshot ${snapshot} in ${paths.state}: ${(err as Error).message}`);
    return 1;
  }
  const nodes: IRNode[] = [];
  const edges: IREdge[] = [];
  for (const r of records) {
    if ("node" in r) nodes.push(r.node);
    else if ("edge" in r) edges.push(r.edge);
  }
  const index = couplingIndex(nodes, edges);

  const raw = args.selector.replace(/\\/g, "/");
  if (raw.split("/").includes("..")) {
    console.error(`scope must not leave the project: ${args.selector}`);
    return 1;
  }
  const selector = scopeOf(raw);
  let report: CouplingReport;
  if (selector === "") {
    report = couplingReport(index);
  } else if (index.functions.has(selector)) {
    report = couplingReport(index, { ids: [selector] });
  } else {
    // A file or folder is a scope only when an indexed file names it or lies under it, as the server decides it.
    const known = nodes.some((n) => {
      if (n.kind !== "structure.file") return false;
      const path = String(n.attrs.path ?? n.id);
      return path === selector || path.startsWith(`${selector}/`);
    });
    if (!known) {
      console.error(`no such function, file or scope: ${args.selector}`);
      return 1;
    }
    report = couplingReport(index, { scope: selector });
  }
  console.log(args.json ? JSON.stringify(report) : formatCoupling(report));
  return 0;
}
