import { resolve } from "node:path";
import { loadState, projectPaths, readSnapshot } from "@insight/indexer";
import { couplingIndex, couplingReport, normalizeScopeInput, ScopeInputError, type CouplingReport } from "@insight/flow";
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

/**
 * `insight coupling <fn|file|scope>`: read an existing snapshot, build its coupling index, and print the report of one
 * function, one file, a folder prefix, or the whole project. It never indexes: without a snapshot it says so and exits 1,
 * so an agent never waits on a silent full index. `--json` prints the route's bytes (`JSON.stringify(report)`).
 *
 * The selector is normalized by the same function the HTTP routes use (a leading `/` or a `..` segment is refused), and
 * that check runs before the snapshot is read or the index is built. A selector that names an indexed file is always a
 * file scope, even when the file's top-level flow id is the file path: the report then holds the top-level flow and every
 * function in the file, exactly as `?scope=<path>` does. Otherwise an exact function id, then an exact function name, is
 * one function; a folder is a scope; anything else is an error.
 */
export async function runCoupling(args: CouplingArgs): Promise<number> {
  const root = resolve(args.project ?? ".");
  const paths = projectPaths(root, args.state !== undefined ? resolve(args.state) : undefined);

  let selector: string;
  try {
    selector = normalizeScopeInput(args.selector);
  } catch (err) {
    if (err instanceof ScopeInputError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }

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

  // Resolve the selector's scope and cheap existence before building the whole coupling index: an invalid selector must
  // not pay the project's cost. Function ids and names are node-level facts, so they need no index either.
  const files = new Set<string>();
  for (const n of nodes) if (n.kind === "structure.file") files.add(String(n.attrs.path ?? n.id));
  const isFile = selector !== "" && files.has(selector);
  let isFolder = false;
  if (selector !== "") {
    for (const file of files) {
      if (file.startsWith(`${selector}/`)) {
        isFolder = true;
        break;
      }
    }
  }
  const named = (n: IRNode): boolean =>
    n.kind === "structure.function" &&
    (n.id === selector || String(n.attrs.name ?? "") === selector || String(n.attrs.qualifiedName ?? "") === selector);
  if (selector !== "" && !isFile && !isFolder && !nodes.some(named)) {
    console.error(`no such function, file or scope: ${args.selector}`);
    return 1;
  }

  const index = couplingIndex(nodes, edges);
  let report: CouplingReport;
  if (selector === "") {
    report = couplingReport(index);
  } else if (isFile) {
    // The file path, the top-level flow's id and every function in the file: the same set as `?scope=<path>`.
    report = couplingReport(index, { scope: selector });
  } else if (index.functions.has(selector)) {
    report = couplingReport(index, { ids: [selector] });
  } else {
    const matches = [...index.functions.values()].filter((f) => f.name === selector);
    if (matches.length > 0) {
      report = couplingReport(index, { ids: matches.map((f) => f.id) });
    } else if (isFolder) {
      report = couplingReport(index, { scope: selector });
    } else {
      console.error(`no such function, file or scope: ${args.selector}`);
      return 1;
    }
  }
  console.log(args.json ? JSON.stringify(report) : formatCoupling(report));
  return 0;
}
