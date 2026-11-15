import { readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson, loadState, projectPaths, runIndex, sha256 } from "../src/index.js";

// A frontend's inputs hash decides whether its shards are stale. With inputListing, a matching file contributes only
// its path, so adding a file re-extracts the frontend while editing a file that is only listed does not. Without
// inputListing the hash is the old formula over the contents of the inputs files.
const here = dirname(fileURLToPath(import.meta.url));
const SCRATCH = join(here, "..", ".insight-test", `input-listing-${process.pid}`);

function write(root: string, rel: string, text: string): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

// "listed" extracts *.lst with inputs *.cfg and inputListing **/*. "plain" extracts *.pln with the same inputs and
// no inputListing.
function writePlugins(dir: string): void {
  const frontend = (id: string, files: string, listing: string[] | undefined) => {
    write(dir, `${id}/insight-plugin.json`, JSON.stringify({
      id,
      version: "0.1.0",
      irVersion: "^1.0",
      files: [files],
      inputs: ["**/*.cfg"],
      ...(listing === undefined ? {} : { inputListing: listing }),
      provides: ["structure"],
      roles: { frontend: "index.mjs" },
    }));
    write(dir, `${id}/index.mjs`, `export default {
  id: ${JSON.stringify(id)},
  version: "0.1.0",
  provides: ["structure"],
  async detect() { return { reason: "${id} files" }; },
  async *extract(ctx) {
    for (const file of ctx.files) yield { file, records: [] };
  },
};
`);
  };
  frontend("listed", "**/*.lst", ["**/*"]);
  frontend("plain", "**/*.pln", undefined);
}

function makeProject(name: string): string {
  const project = join(SCRATCH, name);
  write(project, "x.cfg", "option = 1\n");
  write(project, "a.txt", "one\n");
  write(project, "g/one.lst", "one\n");
  write(project, "g/two.pln", "two\n");
  return project;
}

const opts = (projectPath: string, full: boolean) => ({
  projectPath,
  full,
  builtinRoot: join(SCRATCH, "no-builtins"),
  userPluginDir: join(SCRATCH, "no-user-plugins"),
  extraDirs: [join(SCRATCH, "plugins")],
});

const inputsHashOf = (project: string, id: string): string | undefined =>
  loadState(projectPaths(project)).frontends[id]?.inputsHash;

beforeAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  writePlugins(join(SCRATCH, "plugins"));
});

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe("inputListing", () => {
  it("changes inputsHash and re-extracts the frontend when a file is added under the listing", async () => {
    const project = makeProject("added");
    await runIndex(opts(project, true));
    const before = inputsHashOf(project, "listed");
    expect(before).toBeDefined();

    write(project, "g/new.txt", "added\n");
    const report = await runIndex(opts(project, false));
    expect(inputsHashOf(project, "listed")).not.toBe(before);
    expect(report.extracted).toContainEqual({ frontend: "listed", file: "g/one.lst" });
    // The plain frontend has no listing, so the new file does not touch its hash.
    expect(report.extracted.filter((e) => e.frontend === "plain")).toEqual([]);
  }, 120_000);

  it("keeps inputsHash when a listed file's contents change, and does not re-extract the frontend", async () => {
    const project = makeProject("edited");
    await runIndex(opts(project, true));
    const before = inputsHashOf(project, "listed");

    write(project, "a.txt", "two, edited\n");
    const report = await runIndex(opts(project, false));
    expect(inputsHashOf(project, "listed")).toBe(before);
    expect(report.extracted.filter((e) => e.frontend === "listed")).toEqual([]);
  }, 120_000);

  it("uses the old formula over the inputs contents when there is no inputListing", async () => {
    const project = makeProject("formula");
    await runIndex(opts(project, true));
    // Only x.cfg matches inputs, so the hash is over its path and its content hash, as before inputListing existed.
    const expected = sha256(canonicalJson([["x.cfg", sha256(readFileSync(join(project, "x.cfg")))]]));
    expect(inputsHashOf(project, "plain")).toBe(expected);

    write(project, "x.cfg", "option = 2\n");
    await runIndex(opts(project, false));
    const edited = sha256(canonicalJson([["x.cfg", sha256(readFileSync(join(project, "x.cfg")))]]));
    expect(edited).not.toBe(expected);
    expect(inputsHashOf(project, "plain")).toBe(edited);
  }, 120_000);
});
