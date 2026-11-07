import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { IRRecord } from "@insight/ir";
import { canonicalJson, sha256, writeFileAtomic } from "./util.js";

/** Shard key: a digest of everything the extraction of one file depends on, except dependency digests. */
export function shardKey(parts: Record<string, unknown>): string {
  return sha256(canonicalJson(parts));
}

export function shardName(key: string): string {
  return `${key}.ndjson`;
}

export function writeShard(dir: string, key: string, records: IRRecord[]): void {
  const text = records.map((r) => canonicalJson(r)).join("\n");
  writeFileAtomic(join(dir, shardName(key)), text === "" ? "" : `${text}\n`);
}

export function readShard(dir: string, key: string): IRRecord[] | undefined {
  const file = join(dir, shardName(key));
  if (!existsSync(file)) return undefined;
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as IRRecord);
}

/** Deletes shard files nobody references any more. Returns how many were removed. */
export function gcShards(dir: string, keep: Set<string>): number {
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".ndjson") || keep.has(name)) continue;
    rmSync(join(dir, name));
    removed++;
  }
  return removed;
}
