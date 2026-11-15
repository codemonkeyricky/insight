import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runIndex } from "../src/index.js";

// A file whose $schema names a schema that does not exist yet depends on that path anyway, so adding the schema later
// re-extracts the dependent file and nothing else.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..", "..");
const SCRATCH = join(here, "..", ".insight-test", `jsonschema-freshness-${process.pid}`);
const project = join(SCRATCH, "generic");
const fixture = join(repoRoot, "packages", "frontend", "jsonschema", "test", "fixtures", "generic");

const options = (full: boolean) => ({ projectPath: project, builtinRoot: repoRoot, userPluginDir: join(SCRATCH, "no-user-plugins"), full });

beforeAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  cpSync(fixture, project, { recursive: true });
}, 60_000);

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe("frontend-jsonschema freshness", () => {
  it("re-extracts an instance when the schema it named but could not find is added", async () => {
    const first = await runIndex(options(true));
    expect(first.extracted).toContainEqual({ frontend: "frontend-jsonschema", file: "data/bob.json" });

    const second = await runIndex(options(false));
    expect(second.extracted.filter((e) => e.frontend === "frontend-jsonschema")).toEqual([]);

    writeFileSync(join(project, "schemas", "missing.schema.json"), JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", title: "Missing", type: "object" }));
    const third = await runIndex(options(false));
    expect(third.extracted).toContainEqual({ frontend: "frontend-jsonschema", file: "data/bob.json" });
  }, 120_000);
});
