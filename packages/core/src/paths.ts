import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Name of the per-project state folder. It is always excluded from scanning. */
export const STATE_DIR = ".insight";

export interface ProjectPaths {
  root: string;
  state: string;
  shards: string;
  snapshots: string;
  stateFile: string;
  treeFile: string;
  statCache: string;
  indexDb: string;
  localPlugins: string;
  analysis: string;
  lensConfigs: string;
  /** Review decisions and annotations, kept by the user. */
  review: string;
  annotations: string;
}

export function projectPaths(root: string): ProjectPaths {
  const abs = resolve(root);
  const state = join(abs, STATE_DIR);
  return {
    root: abs,
    state,
    shards: join(state, "shards"),
    snapshots: join(state, "snapshots"),
    stateFile: join(state, "state.json"),
    treeFile: join(state, "tree.json"),
    statCache: join(state, "stat-cache.json"),
    indexDb: join(state, "index.sqlite"),
    localPlugins: join(state, "plugins"),
    analysis: join(state, "analysis"),
    lensConfigs: join(state, "lenses"),
    review: join(state, "review.json"),
    annotations: join(state, "annotations.json"),
  };
}

/** The repository root: the nearest ancestor of this file that holds pnpm-workspace.yaml. */
export function repoRoot(from: string = fileURLToPath(import.meta.url)): string | undefined {
  let dir = dirname(resolve(from));
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
