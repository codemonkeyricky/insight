import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import frontend from "../src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (name: string) => JSON.parse(readFileSync(join(root, name), "utf8")) as { version: string };

// The indexer reuses a shard only when its recorded frontend version equals the runtime one (pipeline.ts), so the three
// copies of the version must match or a stale shard is reused under a newer frontend.
describe("frontend-typescript version", () => {
  it("index.ts reports the version of package.json and insight-plugin.json", () => {
    expect(frontend.version).toBe(readJson("package.json").version);
    expect(frontend.version).toBe(readJson("insight-plugin.json").version);
  });
});
