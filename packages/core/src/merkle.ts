import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ignore, { type Ignore } from "ignore";
import { STATE_DIR } from "./paths.js";
import { compareStrings, sha256 } from "./util.js";

export type TreeNode =
  | { type: "file"; hash: string }
  | { type: "dir"; hash: string; children: Record<string, TreeNode> };

export interface StatEntry {
  size: number;
  mtimeMs: number;
  hash: string;
}
export type StatCache = Record<string, StatEntry>;

export interface ScanResult {
  /** Root directory node. Each directory hash covers its sorted children. */
  tree: TreeNode;
  /** Project-relative POSIX path to content hash, sorted by path. */
  files: Map<string, string>;
  /** Stat entries for the files just scanned. Replaces the previous cache. */
  stats: StatCache;
  /** Number of files whose content was read because the stat cache did not match. */
  rehashed: number;
}

export interface TreeDiff {
  added: string[];
  removed: string[];
  modified: string[];
  /** A removed and an added file with the same content hash. */
  renamed: { from: string; to: string }[];
}

const ALWAYS_IGNORED = [STATE_DIR, ".git", "node_modules"];

/** Ignore rules: the built-in list plus the project's root .gitignore. */
export function loadIgnore(root: string): Ignore {
  const ig = ignore().add(ALWAYS_IGNORED);
  try {
    ig.add(readFileSync(join(root, ".gitignore"), "utf8"));
  } catch {
    // no .gitignore is fine
  }
  return ig;
}

function dirHash(children: Record<string, TreeNode>): string {
  const lines = Object.keys(children)
    .sort(compareStrings)
    .map((name) => {
      const child = children[name] as TreeNode;
      return `${name}\0${child.type}\0${child.hash}\n`;
    });
  return sha256(lines.join(""));
}

/**
 * Walks the project and builds its Merkle tree. A file's hash is reused from the stat cache when
 * its size and mtime are unchanged, so unchanged files are not read.
 */
export function scanProject(root: string, previous: StatCache = {}): ScanResult {
  const ig = loadIgnore(root);
  const stats: StatCache = {};
  const files = new Map<string, string>();
  let rehashed = 0;

  const walk = (rel: string): TreeNode => {
    const abs = rel === "" ? root : join(root, rel);
    const children: Record<string, TreeNode> = {};
    const entries = readdirSync(abs, { withFileTypes: true }).sort((a, b) => compareStrings(a.name, b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (ig.ignores(`${childRel}/`)) continue;
        children[entry.name] = walk(childRel);
      } else if (entry.isFile()) {
        if (ig.ignores(childRel)) continue;
        const st = statSync(join(root, childRel));
        const cached = previous[childRel];
        let hash: string;
        if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
          hash = cached.hash;
        } else {
          hash = sha256(readFileSync(join(root, childRel)));
          rehashed++;
        }
        stats[childRel] = { size: st.size, mtimeMs: st.mtimeMs, hash };
        files.set(childRel, hash);
        children[entry.name] = { type: "file", hash };
      }
    }
    return { type: "dir", hash: dirHash(children), children };
  };

  const tree = walk("");
  const sorted = new Map([...files.entries()].sort(([a], [b]) => compareStrings(a, b)));
  return { tree, files: sorted, stats, rehashed };
}

/** Lists the files under a node as [path, hash] pairs. */
function filesUnder(node: TreeNode, rel: string): [string, string][] {
  if (node.type === "file") return [[rel, node.hash]];
  const out: [string, string][] = [];
  for (const name of Object.keys(node.children).sort(compareStrings)) {
    out.push(...filesUnder(node.children[name] as TreeNode, rel ? `${rel}/${name}` : name));
  }
  return out;
}

/**
 * Compares two trees. Directories with equal hashes are skipped whole, so the work is
 * proportional to what changed. A removed file and an added file with the same hash are
 * reported as a rename.
 */
export function diffTrees(prev: TreeNode | undefined, next: TreeNode | undefined): TreeDiff {
  const removed: [string, string][] = [];
  const added: [string, string][] = [];
  const modified: string[] = [];

  const visit = (a: TreeNode | undefined, b: TreeNode | undefined, rel: string): void => {
    if (a && b && a.type === b.type && a.hash === b.hash) return;
    if (a?.type === "dir" && b?.type === "dir") {
      const names = new Set([...Object.keys(a.children), ...Object.keys(b.children)]);
      for (const name of [...names].sort(compareStrings)) {
        visit(a.children[name], b.children[name], rel ? `${rel}/${name}` : name);
      }
      return;
    }
    if (a?.type === "file" && b?.type === "file") {
      modified.push(rel);
      return;
    }
    if (a) removed.push(...filesUnder(a, rel));
    if (b) added.push(...filesUnder(b, rel));
  };
  visit(prev, next, "");

  const renamed: { from: string; to: string }[] = [];
  const addedLeft: [string, string][] = [];
  const removedLeft = [...removed];
  for (const [to, hash] of added) {
    const idx = removedLeft.findIndex(([, h]) => h === hash);
    if (idx >= 0) {
      const [from] = removedLeft.splice(idx, 1)[0] as [string, string];
      renamed.push({ from, to });
    } else {
      addedLeft.push([to, hash]);
    }
  }
  return {
    added: addedLeft.map(([p]) => p).sort(compareStrings),
    removed: removedLeft.map(([p]) => p).sort(compareStrings),
    modified: modified.sort(compareStrings),
    renamed: renamed.sort((x, y) => compareStrings(x.to, y.to)),
  };
}
