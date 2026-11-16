import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** Concatenated text of every shard in the scratch project's index. */
const shardText = (): string => {
  const dir = join(project, ".insight", "shards");
  return readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
};

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

  it("re-extracts the schema that referred to a not-yet-existing relative file when it appears", async () => {
    writeFileSync(join(project, "schemas", "refers.schema.json"), JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", title: "Refers", properties: { g: { $ref: "./later.schema.json" } } }));
    await runIndex(options(false));
    const quiet = await runIndex(options(false));
    expect(quiet.extracted.filter((e) => e.frontend === "frontend-jsonschema")).toEqual([]);
    writeFileSync(join(project, "schemas", "later.schema.json"), JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", title: "Later", type: "string" }));
    const after = await runIndex(options(false));
    expect(after.extracted).toContainEqual({ frontend: "frontend-jsonschema", file: "schemas/refers.schema.json" });
  }, 120_000);

  it("re-extracts the plugin's shards when a TypeScript file is added (inputListing)", async () => {
    await runIndex(options(false));
    mkdirSync(join(project, "packages", "x"), { recursive: true });
    writeFileSync(join(project, "packages", "x", "emit.ts"), "export const k = 'sync.thing';\n");
    const after = await runIndex(options(false));
    expect(after.extracted).toContainEqual({ frontend: "frontend-jsonschema", file: "data/alice.json" });
  }, 120_000);

  it("re-extracts a kinds shard when an existing schema file gains, in place, the $id its absolute attrs $ref named", async () => {
    const attrs = join(project, "schemas", "later-attrs.schema.json");
    const body = { $schema: "https://json-schema.org/draft/2020-12/schema", title: "LaterAttrs", type: "object" };
    mkdirSync(join(project, "kinds-ref"), { recursive: true });
    writeFileSync(join(project, "kinds-ref", "kinds.json"), JSON.stringify([{ kind: "sync.later", facet: "structure", on: "node", attrs: { $ref: "https://example.com/later-attrs.json" } }]));
    writeFileSync(attrs, JSON.stringify(body));
    await runIndex(options(false));
    const quiet = await runIndex(options(false));
    expect(quiet.extracted.filter((e) => e.frontend === "frontend-jsonschema")).toEqual([]);
    expect(shardText()).not.toContain('"x-schema.attrs"');
    // Same file listing: only the schema's content changes.
    writeFileSync(attrs, JSON.stringify({ ...body, $id: "https://example.com/later-attrs.json" }));
    const after = await runIndex(options(false));
    expect(after.extracted).toContainEqual({ frontend: "frontend-jsonschema", file: "kinds-ref/kinds.json" });
    expect(shardText()).toContain('"x-schema.attrs"');
  }, 120_000);

  it("re-extracts instances (also under fixtures/) when a broken schema they named is fixed in place", async () => {
    const broken = join(project, "schemas", "broken.schema.json");
    writeFileSync(broken, "{ not json");
    mkdirSync(join(project, "data", "fixtures"), { recursive: true });
    writeFileSync(join(project, "data", "carol.json"), JSON.stringify({ $schema: "../schemas/broken.schema.json" }));
    writeFileSync(join(project, "data", "fixtures", "dave.json"), JSON.stringify({ $schema: "../../schemas/broken.schema.json" }));
    await runIndex(options(false));
    const quiet = await runIndex(options(false));
    expect(quiet.extracted.filter((e) => e.frontend === "frontend-jsonschema")).toEqual([]);
    writeFileSync(broken, JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", title: "Broken", type: "object" }));
    const after = await runIndex(options(false));
    expect(after.extracted).toContainEqual({ frontend: "frontend-jsonschema", file: "data/carol.json" });
    expect(after.extracted).toContainEqual({ frontend: "frontend-jsonschema", file: "data/fixtures/dave.json" });
  }, 120_000);
});
