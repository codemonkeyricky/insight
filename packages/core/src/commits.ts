import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { analysisPath, readAnalysis, type AnalysisFile } from "./analyze.js";
import { diffSnapshots, type SnapshotDiff } from "./diff.js";
import { projectPaths } from "./paths.js";
import { runIndex, type IndexOptions } from "./pipeline.js";
import { readSnapshot, snapshotExists } from "./snapshots.js";
import { InputError } from "./util.js";
import { loadState } from "./state.js";

/** Runs git in the project folder. Arguments are an array, never a shell string. */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** True when the folder is a git working tree. */
export function isGitCheckout(dir: string): boolean {
  if (!existsSync(join(dir, ".git"))) return false;
  try {
    return git(dir, ["rev-parse", "--is-inside-work-tree"]) === "true";
  } catch {
    return false;
  }
}

/** Resolves a ref (branch, tag, or commit id) to a full commit id. */
export function resolveCommit(dir: string, ref: string): string {
  if (ref.trim() === "" || ref.startsWith("-")) throw new InputError(`not a commit: ${JSON.stringify(ref)}`);
  try {
    return git(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  } catch {
    throw new InputError(`not a commit in this repository: ${ref}`);
  }
}

/** Per-commit folder under the project's state folder. Its tree is the commit, unpacked. */
export function commitRoot(projectPath: string, commit: string): string {
  return join(projectPaths(projectPath).state, "commits", commit, "tree");
}

/**
 * Unpacks a commit's committed files into an empty folder, with git archive. Uncommitted edits are not
 * in it, which is the point: the snapshot is exactly the commit.
 */
export function archiveCommit(projectPath: string, commit: string, dest: string): void {
  const work = join(dest, "..");
  const tar = join(work, `${commit}.tar`);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  mkdirSync(work, { recursive: true });
  try {
    git(projectPath, ["archive", "--format=tar", "-o", tar, commit]);
    execFileSync("tar", ["-xf", tar, "-C", dest], { stdio: ["ignore", "ignore", "pipe"] });
  } finally {
    rmSync(tar, { force: true });
  }
}

export interface IndexedCommit {
  commit: string;
  root: string;
  snapshot: string;
  /** False when an earlier run already indexed this commit, so nothing was extracted now. */
  reused: boolean;
}

export type CommitIndexOptions = Pick<IndexOptions, "builtinRoot" | "userPluginDir" | "extraDirs" | "allowBuildTools" | "onProgress">;

/**
 * Makes sure a commit has a full index under the project's state folder and returns its snapshot. A commit
 * that was indexed before is reused as it is, since a commit's content never changes.
 */
export async function indexCommit(projectPath: string, commit: string, opts: CommitIndexOptions = {}): Promise<IndexedCommit> {
  const root = commitRoot(projectPath, commit);
  const paths = projectPaths(root);
  const state = loadState(paths);
  // A commit's content never changes, so any earlier snapshot of it is still the right answer, as long as its files are there.
  const earlier = state.snapshots.find(
    (s) => s.commit === commit && snapshotExists(paths, s.id) && existsSync(analysisPath(paths, s.id)),
  );
  if (earlier) {
    return { commit, root, snapshot: earlier.id, reused: true };
  }
  archiveCommit(projectPath, commit, root);
  const report = await runIndex({ ...opts, projectPath: root, commit, full: true });
  return { commit, root, snapshot: report.snapshot, reused: false };
}

export interface CommitComparison {
  base: IndexedCommit;
  head: IndexedCommit;
  diff: SnapshotDiff;
}

function inputsOf(indexed: IndexedCommit): { records: ReturnType<typeof readSnapshot>; analysis: AnalysisFile | undefined } {
  const paths = projectPaths(indexed.root);
  return { records: readSnapshot(paths, indexed.snapshot), analysis: readAnalysis(paths, indexed.snapshot) };
}

/**
 * Indexes two commits of a git project, each from its own unpacked tree, and diffs the snapshots. The project's
 * own working tree and index are not touched.
 */
export async function compareCommits(projectPath: string, baseRef: string, headRef: string, opts: CommitIndexOptions = {}): Promise<CommitComparison> {
  if (!isGitCheckout(projectPath)) throw new InputError("this project is not a git checkout, so commits cannot be compared");
  const baseCommit = resolveCommit(projectPath, baseRef);
  const headCommit = resolveCommit(projectPath, headRef);
  const base = await indexCommit(projectPath, baseCommit, opts);
  const head = base.commit === headCommit ? base : await indexCommit(projectPath, headCommit, opts);
  const diff = diffSnapshots(inputsOf(base), inputsOf(head));
  return { base, head, diff };
}
