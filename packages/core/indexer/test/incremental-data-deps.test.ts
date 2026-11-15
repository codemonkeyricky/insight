import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectPaths, readSnapshot, runIndex } from "../src/index.js";

// A data edge names a variable declared in another file (a C++ definition, a TypeScript global writer). The reading file
// must depend on that file, so an incremental re-index re-extracts it when the declaration or the write changes, and no
// edge is left pointing at a node that no longer exists.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..", "..");
const SCRATCH = join(here, "..", ".insight-test", `incremental-data-deps-${process.pid}`);

const options = (projectPath: string, full: boolean) => ({
  projectPath,
  builtinRoot: repoRoot,
  userPluginDir: join(SCRATCH, "no-user-plugins"),
  full,
});

beforeAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
});

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe("incremental data dependencies", () => {
  it("re-extracts a TypeScript global reader when its writer drops the write, and leaves no dangling read", async () => {
    const project = join(SCRATCH, "ts-global");
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(join(project, "package.json"), '{"name":"ts-global"}');
    writeFileSync(join(project, "tsconfig.json"), '{"compilerOptions":{"strict":true},"include":["src"]}');
    writeFileSync(join(project, "src", "w.ts"), "export function wr() { (globalThis as any).x = 1; }\n");
    writeFileSync(join(project, "src", "b.ts"), "export function rd() { return (globalThis as any).x; }\n");

    const first = await runIndex(options(project, true));
    expect(first.problems).toEqual([]);
    const firstEdges = readSnapshot(projectPaths(project), first.snapshot).flatMap((r) => ("edge" in r ? [r.edge] : []));
    expect(firstEdges).toContainEqual(expect.objectContaining({ kind: "data.read", from: "src/b.ts#rd", to: "<global>#global:x" }));

    writeFileSync(join(project, "src", "w.ts"), "export function wr() { return 1; }\n");
    const second = await runIndex(options(project, false));
    expect(second.extracted).toContainEqual({ frontend: "frontend-typescript", file: "src/b.ts" });
    expect(second.problems).toEqual([]);
    const secondEdges = readSnapshot(projectPaths(project), second.snapshot).flatMap((r) => ("edge" in r ? [r.edge] : []));
    expect(secondEdges.filter((e) => e.kind === "data.read" && e.to === "<global>#global:x")).toEqual([]);
  }, 240_000);

  it("re-extracts a C++ file when the file that declares a variable it writes moves the declaration, with zero problems", async () => {
    const project = join(SCRATCH, "cpp-decl");
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(join(project, "CMakeLists.txt"), "project(p)\nadd_executable(p src/a.cc src/b.cc)\n");
    writeFileSync(join(project, "src", "b.cc"), "int shared;\n");
    writeFileSync(join(project, "src", "a.cc"), "extern int shared;\nvoid f() { shared++; }\n");

    const first = await runIndex(options(project, true));
    expect(first.problems).toEqual([]);
    const firstEdges = readSnapshot(projectPaths(project), first.snapshot).flatMap((r) => ("edge" in r ? [r.edge] : []));
    expect(firstEdges).toContainEqual(expect.objectContaining({ kind: "data.write", from: "src/a.cc#f", to: "src/b.cc#var:shared" }));

    writeFileSync(join(project, "src", "b.cc"), "int renamed;\n");
    const second = await runIndex(options(project, false));
    expect(second.extracted).toContainEqual({ frontend: "frontend-cpp", file: "src/a.cc" });
    expect(second.problems).toEqual([]);
  }, 240_000);
});
