import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportProject, type ExportResult } from "../src/index.js";

const FIXED = [
  "project.json",
  "model.json",
  "lenses.json",
  "findings.json",
  "graph.json",
  "files.json",
  "flow-summary.json",
  "meta.json",
  "scope/@root/lenses.json",
  "scope/@root/arch.json",
];

/** A tiny TypeScript project with two source files and a function in each. */
function writeFixture(dir: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "proj", version: "0.0.0", private: true }));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true }, include: ["src"] }),
  );
  writeFileSync(join(dir, "src/a.ts"), `import { b } from "./b.js";\nexport function a(): number {\n  return b() + 1;\n}\n`);
  writeFileSync(join(dir, "src/b.ts"), `export function b(): number {\n  return 2;\n}\n`);
}

/** A project plugin that writes a marker file when it is imported. */
function addEvilPlugin(dir: string, marker: string): void {
  mkdirSync(join(dir, ".insight", "plugins", "evil"), { recursive: true });
  writeFileSync(
    join(dir, ".insight", "plugins", "evil", "insight-plugin.json"),
    JSON.stringify({ id: "evil", version: "0.1.0", irVersion: "^1.0", files: ["**/*.never"], provides: ["structure"], roles: { frontend: "index.mjs" } }),
  );
  writeFileSync(
    join(dir, ".insight", "plugins", "evil", "index.mjs"),
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "ran");
export default { id: "evil", version: "0.1.0", provides: ["structure"], async detect() { return null; }, async *extract() {} };
`,
  );
}

const SCRATCH = mkdtempSync(join(tmpdir(), "insight-export-test-"));
const TIMEOUT = 120_000;

describe("exportProject", () => {
  beforeAll(() => {
    mkdirSync(SCRATCH, { recursive: true });
  });
  afterAll(() => {
    rmSync(SCRATCH, { recursive: true, force: true });
  });

  it(
    "exports exactly the contract's files, and they parse",
    async () => {
      const root = join(SCRATCH, "plain");
      writeFixture(root);
      const result: ExportResult = await exportProject({ root, home: join(SCRATCH, "home-plain"), commit: "abc1234" });

      // The lens results saved are the ok lenses whose listing says they have content.
      const listing = JSON.parse(result.files.get("scope/@root/lenses.json") ?? "{}") as {
        lenses: { id: string; status: string; hasContent?: boolean }[];
      };
      const lensFiles = listing.lenses.filter((l) => l.status === "ok" && l.hasContent === true).map((l) => `scope/@root/${l.id}.json`);
      expect([...result.files.keys()].sort()).toEqual([...FIXED, ...lensFiles].sort());

      const project = JSON.parse(result.files.get("project.json") ?? "{}");
      expect(project.project).toBeDefined();
      expect(project.overview).toBeDefined();
      expect(project.project.source.path).toBe("plain");
      const model = JSON.parse(result.files.get("model.json") ?? "null");
      expect(model).not.toBeNull();
      expect(result.meta.nodes).toBeGreaterThan(0);
      expect(result.meta.commit).toBe("abc1234");
      const meta = JSON.parse(result.files.get("meta.json") ?? "{}");
      expect(meta.nodes).toBe(result.meta.nodes);
      expect(JSON.parse(result.files.get("graph.json") ?? "{}").nodes.length).toBe(result.meta.nodes);
    },
    TIMEOUT,
  );

  it(
    "does not import a project's own plugins",
    async () => {
      const root = join(SCRATCH, "evil");
      writeFixture(root);
      const marker = join(SCRATCH, "marker.txt");
      addEvilPlugin(root, marker);
      await exportProject({ root, home: join(SCRATCH, "home-evil") });
      expect(existsSync(marker)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "rejects a run over a cap with code too_large",
    async () => {
      const root = join(SCRATCH, "capped");
      writeFixture(root);
      const err = await exportProject({ root, home: join(SCRATCH, "home-capped"), limits: { maxFiles: 1 } }).then(
        () => undefined,
        (e: unknown) => e as { code?: string; message?: string },
      );
      expect(err).toBeDefined();
      expect(err?.code).toBe("too_large");
      expect(err?.message).toBeTruthy();
    },
    TIMEOUT,
  );
});
