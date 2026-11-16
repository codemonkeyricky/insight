import { describe, expect, it } from "vitest";
import type { IRDocument, IRNode } from "@insight/ir";
import * as fx from "@insight/sdk/testing";
import { buildProjectModel, systemModel, tierModel, type TierModel } from "../src/index.js";

const file = (path: string): IRNode => fx.node(path, "structure", "structure.file", { attrs: { path }, span: fx.span(path, 0, 0, 0, 0) });

function fn(path: string, name: string): IRNode {
  return fx.node(`${path}#${name}`, "structure", "structure.function", { attrs: { name }, parent: path, span: fx.span(path, 2, 0, 9, 1) });
}

/** An effect owned by a function: its span is the line of the call. */
function effect(path: string, owner: string, line: number, kind: string, attrs: Record<string, unknown>): IRNode {
  return fx.node(`${path}@${kind}:${line}`, "effects", kind, { attrs, parent: `${path}#${owner}`, span: fx.span(path, line, 2, line, 20) });
}

const net = (api: string, attrs: Record<string, unknown>) => ({ api, confidence: "exact", ...attrs });

function call(from: string, to: string, path: string, line: number) {
  return fx.edge(from, to, "calls", "calls.call", { span: fx.span(path, line, 2, line, 12) });
}

/** An import of a package (not a project file): the unresolved text the System model reads. */
function imp(from: string, text: string) {
  return fx.edge(from, { unresolved: { scheme: "module", text } }, "packaging", "packaging.import", {
    span: fx.span(from, 0, 0, 0, 20),
    attrs: { specifier: text, typeOnly: false, dynamic: false },
  });
}

const WEB = "web/src/api.ts";
const MAIN = "web/src/main.ts";
const SRV = "server/src/routes.ts";
const DB = "packages/db/src/index.ts";
const FN = "fn/src/api.ts";
const WK = "worker/index.js";
const SCR = "scripts/dev.mjs";
const TST = "server/test/routes.test.ts";

/**
 * A mini Insight: a browser app (web), a Fastify server that calls a library which opens SQLite (server, packages/db),
 * a Vercel function with dispatch routes and Cloudflare KV and GitHub calls (fn), a Cloudflare Worker with a KV binding
 * (worker, no package.json), and a dev script that listens (scripts). `envName` is the env var the app GETs a URL from.
 */
function miniInsight(envName = "VITE_STORAGE_BASE"): IRDocument {
  const nodes: IRNode[] = [
    // web: a browser app
    file("web/package.json"),
    file("web/index.html"),
    file(MAIN),
    fn(MAIN, "main"),
    file(WEB),
    fn(WEB, "load"),
    effect(WEB, "load", 3, "effects.net.connect", net("fetch", { relative: true, path: "/api/items", method: "GET" })),
    effect(WEB, "load", 4, "effects.net.connect", net("fetch", { relative: true, path: "/api/items/:param/detail", method: "GET" })),
    effect(WEB, "load", 5, "effects.net.connect", net("EventSource", { relative: true, path: "/api/items/:param/events", method: "GET", protocol: "sse" })),
    effect(WEB, "load", 6, "effects.net.connect", net("fetch", { relative: true, path: "/api/index", method: "POST" })),
    effect(WEB, "load", 7, "effects.net.connect", net("fetch", { relative: true, path: "/api/nowhere", method: "GET" })),
    effect(WEB, "load", 8, "effects.net.connect", net("fetch", { path: "k/latest.json", method: "GET", env: envName })),
    effect(WEB, "load", 9, "effects.net.connect", net("fetch", { host: "raw.githubusercontent.com", path: "/o/r/main/x", method: "GET" })),
    // server: Fastify routes, a listen, and a call into the packages/db library
    file("server/package.json"),
    file(SRV),
    fn(SRV, "register"),
    fn(SRV, "list"),
    effect(SRV, "register", 3, "effects.net.serve", { framework: "fastify", method: "GET", path: "/api/items", handler: "list" }),
    effect(SRV, "register", 4, "effects.net.serve", { framework: "fastify", method: "GET", path: "/api/items/:id/detail", handler: "detail" }),
    effect(SRV, "register", 5, "effects.net.serve", { framework: "fastify", method: "GET", path: "/api/items/:id/events", handler: "events" }),
    effect(SRV, "register", 6, "effects.net.listen", { port: 3000 }),
    // packages/db: a library (package.json, no route) that opens SQLite
    file("packages/db/package.json"),
    file(DB),
    fn(DB, "query"),
    // fn: a Vercel function with dispatch routes, a KV REST write and a GitHub read
    file("fn/package.json"),
    file(FN),
    fn(FN, "handle"),
    effect(FN, "handle", 3, "effects.net.serve", { framework: "dispatch", method: "*", path: "/api/index", handler: "index" }),
    effect(FN, "handle", 4, "effects.net.serve", { framework: "dispatch", method: "*", path: "/api/status", handler: "status" }),
    effect(FN, "handle", 5, "effects.net.connect", net("fetch", { host: "api.cloudflare.com", path: "/client/v4/accounts/x/storage/kv/namespaces/y/values/k", method: "PUT" })),
    effect(FN, "handle", 6, "effects.net.connect", net("fetch", { host: "api.github.com", path: "/repos/o/r", method: "GET" })),
    // worker: a Cloudflare Worker folder with wrangler.toml and no package.json
    file("worker/wrangler.toml"),
    file(WK),
    fn(WK, "fetch"),
    effect(WK, "fetch", 2, "effects.net.serve", { framework: "worker", method: "*", path: "/", handler: "fetch", name: "fixture-storage", platform: "cloudflare" }),
    effect(WK, "fetch", 3, "effects.store.access", { api: "env.INDEX", store: "cloudflare-kv", op: "read", binding: "INDEX" }),
    // scripts: a dev script that listens (dropped unless tests are shown)
    file(SCR),
    fn(SCR, "main"),
    effect(SCR, "main", 2, "effects.net.listen", { port: 8080 }),
    // a test file: its facts are noise, so the System model never sees them
    file(TST),
    fn(TST, "t"),
    effect(TST, "t", 3, "effects.net.connect", net("fetch", { host: "api.github.com", path: "/noise", method: "GET" })),
  ];
  const edges: IRDocument["edges"] = [
    call(`${MAIN}#main`, `${WEB}#load`, MAIN, 3),
    imp(MAIN, "react-dom/client"),
    call(`${SRV}#list`, `${DB}#query`, SRV, 8),
    imp(DB, "better-sqlite3"),
    imp(FN, "@vercel/functions"),
  ];
  return { nodes, edges, findings: [] };
}

function tiersOf(doc: IRDocument, opts: { tests?: boolean } = {}): TierModel {
  const m = buildProjectModel(doc);
  return tierModel(m, systemModel(m, "", opts), opts);
}

const nodeKey = (t: TierModel) => t.nodes.map((n) => [n.id, n.tier, n.role ?? "-", n.platform ?? "-", n.label]);
const edgeKey = (t: TierModel) => t.edges.map((e) => [e.from, e.to, e.verb, e.confidence]);

describe("tierModel on the mini Insight", () => {
  const tiers = tiersOf(miniInsight());
  const node = (id: string) => tiers.nodes.find((n) => n.id === id);

  it("draws the deployables and the stores and services they reach, and nothing else", () => {
    expect(nodeKey(tiers)).toEqual([
      ["web", "frontend", "spa", "browser", "web"],
      ["server", "backend", "server", "node", "server"],
      ["fn", "backend", "function", "vercel", "fn"],
      ["worker", "backend", "worker", "cloudflare", "fixture-storage"],
      ["svc:cloudflare-kv", "storage", "-", "-", "Cloudflare KV"],
      ["svc:github-api", "external", "-", "-", "GitHub API"],
      ["svc:github-raw", "external", "-", "-", "GitHub raw"],
      ["store:sqlite", "storage", "-", "-", "SQLite"],
    ]);
  });

  it("lays the nodes out in the four columns, in node order", () => {
    expect(tiers.columns.map((c) => [c.tier, c.title, c.nodes])).toEqual([
      ["frontend", "Frontend", ["web"]],
      ["backend", "Backend", ["server", "fn", "worker"]],
      ["storage", "Storage", ["svc:cloudflare-kv", "store:sqlite"]],
      ["external", "External", ["svc:github-api", "svc:github-raw"]],
    ]);
  });

  it("gives the exact edge set: direct facts exact, the library and env facts inferred", () => {
    expect(edgeKey(tiers)).toEqual([
      ["fn", "svc:cloudflare-kv", "writes", "exact"],
      ["fn", "svc:github-api", "reads", "exact"],
      ["server", "store:sqlite", "opens", "inferred"],
      ["web", "fn", "requests", "exact"],
      ["web", "server", "requests", "exact"],
      ["web", "svc:github-raw", "reads", "exact"],
      ["web", "worker", "reads", "inferred"],
      ["worker", "svc:cloudflare-kv", "reads", "exact"],
    ]);
  });

  it("merges the requests from the app into one edge per backend, with the route labels", () => {
    const toServer = tiers.edges.find((e) => e.from === "web" && e.to === "server");
    expect(toServer).toMatchObject({ label: "GET /api/items, GET /api/items/:id/detail, +1", count: 3 });
    expect(tiers.edges.find((e) => e.from === "web" && e.to === "fn")).toMatchObject({ label: "/api/index", count: 1 });
  });

  it("folds the packages/db library into the server, with via and the library's site", () => {
    expect(tiers.edges.find((e) => e.from === "server" && e.to === "store:sqlite")).toMatchObject({
      label: "better-sqlite3",
      via: ["packages/db"],
      sites: [{ file: DB, line: 1 }],
    });
    expect(node("server")?.libraries).toEqual(["packages/db"]);
    expect(tiers.hidden.libraries).toEqual(["packages/db"]);
  });

  it("reads the Worker for the app's env-named GET, labelled with the env var", () => {
    expect(tiers.edges.find((e) => e.from === "web" && e.to === "worker")).toMatchObject({ verb: "reads", label: "GET via VITE_STORAGE_BASE", confidence: "inferred" });
  });

  it("names the Worker by its wrangler name and records what classified each node", () => {
    expect(node("worker")?.signals).toEqual(["route framework=worker", "wrangler.toml"]);
    expect(node("fn")?.signals).toEqual(["route framework=dispatch", "imports @vercel/functions"]);
    expect(node("web")?.signals).toEqual(["index.html", "imports react-dom/client"]);
    expect(node("worker")?.routes).toBe(1);
    expect(node("server")?.routes).toBe(3);
  });

  it("counts the unmatched relative request, and the library, but draws neither", () => {
    expect(tiers.hidden.unmatchedApi).toBe(1);
    expect(tiers.nodes.some((n) => n.id.startsWith("api:"))).toBe(false);
  });

  it("drops the dev script, counted in hidden.dev, and the test file's facts", () => {
    expect(tiers.nodes.some((n) => n.id === "scripts")).toBe(false);
    expect(tiers.hidden.dev).toBe(1);
    expect(tiers.nodes.some((n) => n.id === "svc:github-api" && n.signals.length === 0)).toBe(false);
  });

  it("has no reason, since the scope has several deployable units", () => {
    expect(tiers.reason).toBeUndefined();
  });

  it("is deterministic", () => {
    expect(tiersOf(miniInsight())).toEqual(tiers);
  });
});

/**
 * A browser app (acme-web) that fetches a URL it builds at run time, and reads the env vars `reads` lists, a Fastify server
 * (acme-api) and a Cloudflare Worker named acme-storage. Every deployable shares the word `acme`.
 */
function envApp(reads: Array<{ file: string; name: string }>): IRDocument {
  const nodes: IRNode[] = [
    file("acme-web/package.json"),
    file("acme-web/index.html"),
    file("acme-web/src/main.ts"),
    fn("acme-web/src/main.ts", "load"),
    effect("acme-web/src/main.ts", "load", 3, "effects.net.connect", net("fetch", { host: "<dynamic>", method: "GET" })),
    file("acme-api/package.json"),
    file("acme-api/src/routes.ts"),
    fn("acme-api/src/routes.ts", "list"),
    effect("acme-api/src/routes.ts", "list", 3, "effects.net.serve", { framework: "fastify", method: "GET", path: "/api/items", handler: "list" }),
    file("acme-storage/wrangler.toml"),
    file("acme-storage/index.js"),
    fn("acme-storage/index.js", "fetch"),
    effect("acme-storage/index.js", "fetch", 2, "effects.net.serve", { framework: "worker", method: "*", path: "/", handler: "fetch", name: "acme-storage", platform: "cloudflare" }),
  ];
  const seen = new Set<string>();
  reads.forEach((r, i) => {
    // A read in the fetch's file is owned by its `load` function; a read elsewhere by a `read` function of its own file.
    const owner = r.file === "acme-web/src/main.ts" ? "load" : "read";
    if (owner === "read" && !seen.has(r.file)) {
      seen.add(r.file);
      nodes.push(file(r.file), fn(r.file, "read"));
    }
    nodes.push(effect(r.file, owner, 10 + i, "effects.env.read", { name: r.name }));
  });
  return { nodes, edges: [imp("acme-web/src/main.ts", "react-dom/client")], findings: [] };
}

describe("tierModel environment heuristic", () => {
  it("ignores an env read in a build config file, so INSIGHT_API-style names match nothing", () => {
    const tiers = tiersOf(envApp([{ file: "acme-web/vite.config.ts", name: "VITE_STORAGE_BASE" }]));
    expect(tiers.edges.some((e) => e.from === "acme-web" && e.to === "acme-storage")).toBe(false);
  });

  it("does not match on a word shared by two or more deployables: ACME_API names no Worker, VITE_STORAGE_BASE does", () => {
    const tiers = tiersOf(
      envApp([
        { file: "acme-web/src/main.ts", name: "ACME_API" },
        { file: "acme-web/src/main.ts", name: "VITE_STORAGE_BASE" },
      ]),
    );
    expect(tiers.edges.find((e) => e.from === "acme-web" && e.to === "acme-storage")).toMatchObject({ verb: "reads", label: "GET via VITE_STORAGE_BASE" });
  });

  it("prefers a name read in the fetch's own file when the matching names tie", () => {
    const tiers = tiersOf(
      envApp([
        { file: "acme-web/src/other.ts", name: "VITE_STORAGE_BASE" },
        { file: "acme-web/src/main.ts", name: "VITE_STORAGE_URL" },
      ]),
    );
    expect(tiers.edges.find((e) => e.to === "acme-storage")).toMatchObject({ label: "GET via VITE_STORAGE_URL" });
  });
});

describe("tierModel options and edge cases", () => {
  it("includes the dev script with opts.tests", () => {
    const tiers = tiersOf(miniInsight(), { tests: true });
    expect(tiers.nodes.find((n) => n.id === "scripts")).toMatchObject({ tier: "backend", role: "server", platform: "node" });
    expect(tiers.hidden.dev).toBe(0);
  });

  it("does not make the env edge when the env name shares no word with the Worker", () => {
    const tiers = tiersOf(miniInsight("VITE_ANALYTICS_URL"));
    expect(tiers.edges.some((e) => e.to === "worker" && e.verb === "reads")).toBe(false);
  });

  it("sets reason when only one deployable is in scope", () => {
    const FNONLY = "fn/src/api.ts";
    const doc: IRDocument = {
      nodes: [
        file("fn/package.json"),
        file(FNONLY),
        fn(FNONLY, "handle"),
        effect(FNONLY, "handle", 3, "effects.net.serve", { framework: "dispatch", method: "*", path: "/api/index", handler: "index" }),
        effect(FNONLY, "handle", 5, "effects.net.connect", net("fetch", { host: "api.cloudflare.com", path: "/client/v4/accounts/x/storage/kv/namespaces/y/values/k", method: "PUT" })),
      ],
      edges: [],
      findings: [],
    };
    const tiers = tiersOf(doc);
    expect(tiers.nodes.filter((n) => n.tier === "backend").map((n) => n.id)).toEqual(["fn"]);
    expect(tiers.reason).toBe("not enough deployable units at this scope (1 found, need 2)");
  });

  it("returns an empty model with a reason for an empty scope", () => {
    const tiers = tiersOf({ nodes: [], edges: [], findings: [] });
    expect(tiers.nodes).toEqual([]);
    expect(tiers.edges).toEqual([]);
    expect(tiers.reason).toBe("not enough deployable units at this scope (0 found, need 2)");
  });
});
