import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ts from "typescript";
import { buildProject } from "../src/extract.js";

// The compiler's disk fallback may read only the project root and the bundled typescript lib folder.
const here = dirname(fileURLToPath(import.meta.url));
const SCRATCH = join(here, "..", ".insight-test", `confine-${process.pid}`);
const ROOT = join(SCRATCH, "proj");
const OUTSIDE = join(SCRATCH, "outside");

describe("the compiler host's disk fallback", () => {
  beforeAll(() => {
    rmSync(SCRATCH, { recursive: true, force: true });
    mkdirSync(join(ROOT, "src"), { recursive: true });
    mkdirSync(OUTSIDE, { recursive: true });
    writeFileSync(join(ROOT, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(ROOT, "src", "inside.ts"), "export const inside = 2;\n");
    writeFileSync(join(OUTSIDE, "secret.ts"), "export const secret = 'x';\n");
    symlinkSync(join(OUTSIDE, "secret.ts"), join(ROOT, "src", "escape.ts"));
  });
  afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

  const build = () => buildProject(ROOT, ["src/a.ts"], new Map([[join(ROOT, "src", "a.ts"), "export const a = 1;\n"]]));

  it("reads a file inside the project root from disk", () => {
    const project = build();
    expect(project.host.fileExists(join(ROOT, "src", "inside.ts"))).toBe(true);
    expect(project.host.readFile(join(ROOT, "src", "inside.ts"))).toContain("inside");
  });

  it("does not read a file outside the project root", () => {
    const project = build();
    expect(project.host.fileExists(join(OUTSIDE, "secret.ts"))).toBe(false);
    expect(project.host.readFile(join(OUTSIDE, "secret.ts"))).toBeUndefined();
    expect(project.host.getSourceFile(join(OUTSIDE, "secret.ts"), ts.ScriptTarget.ES2022)).toBeUndefined();
  });

  it("does not follow a symbolic link that leaves the project root", () => {
    const project = build();
    expect(project.host.fileExists(join(ROOT, "src", "escape.ts"))).toBe(false);
    expect(project.host.readFile(join(ROOT, "src", "escape.ts"))).toBeUndefined();
  });

  it("still reads the bundled lib files", () => {
    const project = build();
    expect(project.host.fileExists(ts.getDefaultLibFilePath(project.options))).toBe(true);
  });
});
