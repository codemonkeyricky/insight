import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IRNode } from "@insight/ir";
import frontend from "../src/index.js";

const FILES: Record<string, string> = {
  "package.json": `${JSON.stringify({ name: "u3-facts", private: true })}\n`,
  // A nested Vite app: its page loads /src/main.ts, which is apps/web/src/main.ts.
  "apps/web/index.html": '<!doctype html>\n<script type="module" src="/src/main.ts"></script>\n',
  "apps/web/src/main.ts": "console.log('boot');\n",
  // import.meta.env: a project variable is an env read, Vite's built-ins are not.
  "apps/web/src/env.ts": "export const base = import.meta.env.VITE_STORAGE_BASE;\nexport const dev = import.meta.env.DEV;\n",
  // EventSource and fetch of the same route, to compare their URL attributes.
  "apps/web/src/sse.ts": [
    "export function watch(id: string) {",
    "  return new EventSource(`/api/items/${id}/events`);",
    "}",
    "export function poll(id: string) {",
    "  return fetch(`/api/items/${id}/events`);",
    "}",
    "",
  ].join("\n"),
  // A page under a test or fixtures folder is not an app's entry.
  "test/fixtures/demo/index.html": '<!doctype html>\n<script type="module" src="/src/app.ts"></script>\n',
  "test/fixtures/demo/src/app.ts": "console.log('fixture');\n",
  // A CRA-style app: its page under public/ loads /src/boot.ts, which is the app's own apps/web/src/boot.ts, not the root's.
  "apps/web/public/index.html": '<!doctype html>\n<script type="module" src="/src/boot.ts"></script>\n',
  "apps/web/src/boot.ts": "console.log('app boot');\n",
  "src/boot.ts": "console.log('root boot');\n",
};

let dir: string;
const nodes: IRNode[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "insight-u3-facts-"));
  for (const [file, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  const ctx = {
    root: { path: dir, name: "u3-facts", allowBuildTools: false },
    files: Object.keys(FILES),
    listFiles: () => Object.keys(FILES),
    readFile: async (rel: string) => readFileSync(join(dir, rel), "utf8"),
    log: () => undefined,
  };
  for await (const batch of frontend.extract(ctx)) {
    for (const r of batch.records) if ("node" in r) nodes.push(r.node);
  }
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const byId = (id: string): IRNode | undefined => nodes.find((n) => n.id === id);

describe("nested index.html entries", () => {
  it("resolves a leading slash in a public/ page against the app folder above public/, not the project root", () => {
    expect(byId("apps/web/src/boot.ts#(module)")?.attrs?.htmlEntry).toBe(true);
    expect(byId("src/boot.ts#(module)")?.attrs?.htmlEntry).not.toBe(true);
  });

  it("makes the module a nested page loads a browser entry, under its own folder", () => {
    expect(byId("apps/web/src/main.ts#(module)")?.attrs?.htmlEntry).toBe(true);
  });

  it("ignores an index.html under test/fixtures", () => {
    expect(byId("test/fixtures/demo/src/app.ts#(module)")?.attrs?.htmlEntry).toBeUndefined();
  });
});

describe("import.meta.env reads", () => {
  const envReads = (file: string): string[] =>
    nodes
      .filter((n) => n.kind === "effects.env.read" && n.id.startsWith(`${file}@`))
      .map((n) => String((n.attrs as { name?: unknown }).name))
      .sort();

  it("reads a project variable the way process.env does", () => {
    expect(envReads("apps/web/src/env.ts")).toEqual(["VITE_STORAGE_BASE"]);
    const read = nodes.find((n) => n.kind === "effects.env.read" && n.id.startsWith("apps/web/src/env.ts@"));
    expect(read?.attrs).toEqual({ api: "process.env", name: "VITE_STORAGE_BASE" });
  });

  it("emits nothing for a Vite built-in such as DEV", () => {
    expect(envReads("apps/web/src/env.ts")).not.toContain("DEV");
  });
});

describe("EventSource connects", () => {
  const connectOf = (fn: string): Record<string, unknown> | undefined =>
    nodes.find((n) => n.kind === "effects.net.connect" && n.parent === `apps/web/src/sse.ts#${fn}`)?.attrs;

  it("connects a new EventSource as a GET stream over sse, with the URL's path", () => {
    expect(connectOf("watch")).toEqual({
      api: "EventSource",
      relative: true,
      path: "/api/items/:param/events",
      method: "GET",
      protocol: "sse",
      confidence: "exact",
    });
  });

  it("names the stream's path the way a fetch of the same URL does", () => {
    const fetched = connectOf("poll");
    expect(fetched?.api).toBe("fetch");
    expect(connectOf("watch")?.path).toBe(fetched?.path);
    expect(connectOf("watch")?.relative).toBe(fetched?.relative);
  });
});
