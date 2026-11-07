import type { ProjectPaths } from "./paths.js";
import { readJsonFile, writeFileAtomic } from "./util.js";

/** Snapshots kept per project. Older ones are deleted when a new one is written. */
export const KEEP_SNAPSHOTS = 20;
export const STATE_SCHEMA_VERSION = 1;

export interface ShardEntry {
  /** Shard key. The shard lives at shards/<key>.ndjson. */
  key: string;
  /** Digest of each other file this shard depends on. A changed digest invalidates the shard. */
  deps: Record<string, string>;
  /** Number of error findings in the shard. */
  errors: number;
}

export interface FrontendState {
  version: string;
  inputsHash: string;
  files: Record<string, ShardEntry>;
}

export interface SnapshotInfo {
  id: string;
  createdAt: string;
  nodes: number;
  edges: number;
  findings: number;
}

export interface IndexState {
  schema: number;
  frontends: Record<string, FrontendState>;
  snapshots: SnapshotInfo[];
  latest?: string;
}

export function emptyState(): IndexState {
  return { schema: STATE_SCHEMA_VERSION, frontends: {}, snapshots: [] };
}

export function loadState(paths: ProjectPaths): IndexState {
  const state = readJsonFile<IndexState>(paths.stateFile, emptyState());
  return state.schema === STATE_SCHEMA_VERSION ? state : emptyState();
}

export function saveState(paths: ProjectPaths, state: IndexState): void {
  writeFileAtomic(paths.stateFile, `${JSON.stringify(state, null, 1)}\n`);
}
