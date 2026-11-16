import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IRNode } from "@insight/ir";
import frontend from "../src/index.js";
import { parseWrangler, WRANGLER_RE } from "../src/deploy.js";

/** The committed storage-worker config, copied so the parse is checked against the real file. */
const STORAGE_TOML = `# The read-only public view of the hosted indexes (Workers KV namespace "insight-index"). Deploy from this folder:
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npx wrangler@4 deploy
# The namespace id is not a secret; scripts/kv-setup.mjs creates or finds it.
name = "insight-storage"
main = "index.js"
compatibility_date = "2026-10-01"
workers_dev = true

[[kv_namespaces]]
binding = "INDEX"
id = "ab014675a88f4badbd9ec95c87112764"
`;

describe("parseWrangler", () => {
  it("reads the name, main and KV binding of the storage-worker config", () => {
    expect(parseWrangler(STORAGE_TOML)).toEqual({
      name: "insight-storage",
      main: "index.js",
      kv: [{ binding: "INDEX", id: "ab014675a88f4badbd9ec95c87112764" }],
      r2: [],
      d1: [],
    });
  });

  it("reads R2 and D1 bindings, and ignores keys under other tables", () => {
    const info = parseWrangler(
      [
        'name = "app"',
        "[vars]",
        'main = "not-the-main.js"',
        'binding = "NOT_A_BINDING"',
        "[[r2_buckets]]",
        'binding = "FILES"',
        'bucket_name = "files-bucket"',
        "[[d1_databases]]",
        'binding = "DB"',
        'database_name = "main-db"',
        "[[env.staging.kv_namespaces]]",
        'binding = "STAGING_ONLY"',
      ].join("\n"),
    );
    expect(info.name).toBe("app");
    expect(info.main).toBeUndefined();
    expect(info.kv).toEqual([]);
    expect(info.r2).toEqual([{ binding: "FILES", bucket: "files-bucket" }]);
    expect(info.d1).toEqual([{ binding: "DB", database: "main-db" }]);
  });

  it("reads the same fields from a JSONC config with comments and trailing commas", () => {
    const info = parseWrangler(
      [
        "{",
        '  // a comment with "quotes" inside',
        '  "name": "json-app",',
        '  "main": "src/worker.ts",',
        '  "kv_namespaces": [{ "binding": "CACHE", "id": "abc", }],',
        '  "d1_databases": [{ "binding": "DB", "database_name": "db" }]',
        "}",
      ].join("\n"),
    );
    expect(info).toEqual({
      name: "json-app",
      main: "src/worker.ts",
      kv: [{ binding: "CACHE", id: "abc" }],
      r2: [],
      d1: [{ binding: "DB", database: "db" }],
    });
  });

  it("matches only wrangler.toml, wrangler.json and wrangler.jsonc, at any depth", () => {
    expect(WRANGLER_RE.test("wrangler.toml")).toBe(true);
    expect(WRANGLER_RE.test("apps/storage-worker/wrangler.jsonc")).toBe(true);
    expect(WRANGLER_RE.test("apps/storage-worker/wrangler.jsonx")).toBe(false);
    expect(WRANGLER_RE.test("apps/storage-worker/mywrangler.toml")).toBe(false);
  });
});

const FILES: Record<string, string> = {
  "package.json": `${JSON.stringify({ name: "u4-deploy", private: true })}\n`,
  // A Worker: its wrangler main is worker/index.js, so its env reads become store facts.
  "worker/wrangler.toml": [
    'name = "fixture-storage"',
    'main = "index.js"',
    "",
    "[[kv_namespaces]]",
    'binding = "INDEX"',
    'id = "0123"',
    "",
    "[[r2_buckets]]",
    'binding = "FILES"',
    'bucket_name = "files"',
    "",
  ].join("\n"),
  "worker/index.js": [
    "export default {",
    "  async fetch(req, env) {",
    "    const { value } = await env.INDEX.getWithMetadata(req.url);",
    "    await env.INDEX.put('k', 'v');",
    "    await env.INDEX.list();",
    "    await env.INDEX.delete('k');",
    "    await env.NOPE.get('x');",
    "    return read(env, 'a');",
    "  },",
    "};",
    "",
    "function read(store, key) {",
    "  return store.FILES.get(key);",
    "}",
    "",
    "export function load(env) {",
    "  return env.INDEX.get('latest');",
    "}",
    "",
  ].join("\n"),
  // The same call in a file no wrangler config deploys: not a platform store.
  "lib/store.js": "export function read(env) {\n  return env.INDEX.get('x');\n}\n",
  // A route table dispatched by pathname: each key is a served route.
  "api/routes.ts": [
    'const PATHS: Record<string, string> = {',
    '  "/api/index": "index",',
    '  "/api/status": "status",',
    "};",
    "export function route(url: URL) {",
    "  return PATHS[url.pathname];",
    "}",
    "",
  ].join("\n"),
  // Not a route table: a key is not a path.
  "api/mixed.ts": [
    'const MIXED = { "/api/a": "a", "b": "b" };',
    "export function pick(url: URL) {",
    "  return MIXED[url.pathname];",
    "}",
    "",
  ].join("\n"),
  // A path-keyed object that nothing dispatches on.
  "api/unused.ts": 'const UNUSED = { "/api/x": "x", "/api/y": "y" };\nexport const names = UNUSED;\n',
};

let dir: string;
const nodes: IRNode[] = [];

async function extractInto(root: string, files: string[], into: IRNode[]): Promise<void> {
  const ctx = {
    root: { path: root, name: "u4", allowBuildTools: false },
    files,
    listFiles: () => files,
    readFile: async (rel: string) => readFileSync(join(root, rel), "utf8"),
    log: () => undefined,
  };
  for await (const batch of frontend.extract(ctx)) {
    for (const r of batch.records) if ("node" in r) into.push(r.node);
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "insight-u4-deploy-"));
  for (const [file, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  await extractInto(dir, Object.keys(FILES), nodes);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ofKind = (kind: string, file?: string): IRNode[] =>
  nodes.filter((n) => n.kind === kind && (file === undefined || n.id.startsWith(`${file}@`)));
const attrsOf = (nodesIn: IRNode[]): Record<string, unknown>[] => nodesIn.map((n) => n.attrs as Record<string, unknown>);

describe("Worker deployed by wrangler", () => {
  it("marks the fetch handler as a Cloudflare Worker under the config's name", () => {
    const serves = ofKind("effects.net.serve", "worker/index.js");
    expect(attrsOf(serves)).toEqual([{ framework: "worker", method: "*", path: "/*", platform: "cloudflare", name: "fixture-storage" }]);
  });

  it("reads a declared KV binding through env as a read, list, write and delete of cloudflare-kv", () => {
    const access = attrsOf(ofKind("effects.store.access", "worker/index.js")).filter((a) => a.binding === "INDEX");
    expect(access).toEqual(
      expect.arrayContaining([
        { api: "env.INDEX.getWithMetadata", store: "cloudflare-kv", op: "read", binding: "INDEX" },
        { api: "env.INDEX.put", store: "cloudflare-kv", op: "write", binding: "INDEX" },
        { api: "env.INDEX.list", store: "cloudflare-kv", op: "list", binding: "INDEX" },
        { api: "env.INDEX.delete", store: "cloudflare-kv", op: "delete", binding: "INDEX" },
        { api: "env.INDEX.get", store: "cloudflare-kv", op: "read", binding: "INDEX" },
      ]),
    );
    expect(access).toHaveLength(5);
  });

  it("does not follow a binding reached through a parameter that is not named env", () => {
    const access = attrsOf(ofKind("effects.store.access", "worker/index.js")).filter((a) => a.binding === "FILES");
    // read(store, key) receives the binding object as store, not env, so only env parameters count: nothing here.
    expect(access).toEqual([]);
  });

  it("emits nothing for an undeclared binding", () => {
    const access = attrsOf(ofKind("effects.store.access", "worker/index.js"));
    expect(access.some((a) => a.binding === "NOPE")).toBe(false);
  });

  it("does not treat a file no wrangler config deploys as a platform store", () => {
    expect(ofKind("effects.store.access", "lib/store.js")).toEqual([]);
    expect(ofKind("effects.net.serve", "lib/store.js")).toEqual([]);
  });
});

describe("dispatch tables", () => {
  it("serves one dispatch route per key of a table read by pathname", () => {
    const serves = ofKind("effects.net.serve", "api/routes.ts");
    expect(attrsOf(serves)).toEqual([
      { framework: "dispatch", method: "*", path: "/api/index", handler: "index" },
      { framework: "dispatch", method: "*", path: "/api/status", handler: "status" },
    ]);
  });

  it("emits nothing for a table with a key that is not a path", () => {
    expect(ofKind("effects.net.serve", "api/mixed.ts")).toEqual([]);
  });

  it("emits nothing for a path-keyed object no pathname lookup reads", () => {
    expect(ofKind("effects.net.serve", "api/unused.ts")).toEqual([]);
  });
});

describe("real files: apps/hosted/src/vercel.ts and apps/storage-worker", () => {
  const repo = fileURLToPath(new URL("../../../../", import.meta.url));
  const real = ["apps/hosted/src/vercel.ts", "apps/storage-worker/index.js", "apps/storage-worker/wrangler.toml"];
  const realDir = mkdtempSync(join(tmpdir(), "insight-u4-real-"));
  const realNodes: IRNode[] = [];

  beforeAll(async () => {
    for (const rel of real) {
      mkdirSync(dirname(join(realDir, rel)), { recursive: true });
      writeFileSync(join(realDir, rel), readFileSync(join(repo, rel), "utf8"));
    }
    await extractInto(realDir, real, realNodes);
  });

  afterAll(() => {
    rmSync(realDir, { recursive: true, force: true });
  });

  it("serves the twelve hosted routes of the PATHS table", () => {
    const paths = attrsOf(realNodes.filter((n) => n.kind === "effects.net.serve" && n.id.startsWith("apps/hosted/src/vercel.ts@")))
      .filter((a) => a.framework === "dispatch")
      .map((a) => a.path);
    expect(paths).toEqual([
      "/api/index",
      "/api/status",
      "/api/coupling",
      "/api/health",
      "/api/auth/login",
      "/api/auth/callback",
      "/api/auth/logout",
      "/api/auth/me",
      "/api/private/grant",
      "/api/private/source",
      "/api/private/latest",
      "/api/private/repos",
    ]);
  });

  it("marks the storage Worker and records its KV reads of the INDEX binding", () => {
    const serve = realNodes.filter((n) => n.kind === "effects.net.serve" && n.id.startsWith("apps/storage-worker/index.js@"));
    expect(attrsOf(serve)).toEqual([{ framework: "worker", method: "*", path: "/*", platform: "cloudflare", name: "insight-storage" }]);
    const access = attrsOf(realNodes.filter((n) => n.kind === "effects.store.access" && n.id.startsWith("apps/storage-worker/index.js@")));
    expect(access).toEqual([{ api: "env.INDEX.getWithMetadata", store: "cloudflare-kv", op: "read", binding: "INDEX" }]);
  });
});
