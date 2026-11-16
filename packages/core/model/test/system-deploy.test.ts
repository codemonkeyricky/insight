import { describe, expect, it } from "vitest";
import type { IRDocument, IRNode } from "@insight/ir";
import * as fx from "@insight/sdk/testing";
import { buildProjectModel, pipelineModel, systemModel, type SystemModel } from "../src/index.js";
import { storeDriverOf } from "../src/services.js";

const file = (path: string): IRNode => fx.node(path, "structure", "structure.file", { attrs: { path }, span: fx.span(path, 0, 0, 0, 0) });

function fn(path: string, name: string): IRNode {
  return fx.node(`${path}#${name}`, "structure", "structure.function", { attrs: { name }, parent: path, span: fx.span(path, 2, 0, 9, 1) });
}

/** An effect owned by a function: its span is the line of the call. */
function effect(path: string, owner: string, line: number, kind: string, attrs: Record<string, unknown>): IRNode {
  return fx.node(`${path}@${kind}:${line}`, "effects", kind, { attrs, parent: `${path}#${owner}`, span: fx.span(path, line, 2, line, 20) });
}

const net = (api: string, attrs: Record<string, unknown>) => ({ api, confidence: "exact", ...attrs });

const modelOf = (doc: IRDocument) => buildProjectModel(doc);

/**
 * A client in apps/web making relative requests, and one server per entry: each serves one route, from its own component
 * folder. The servers' framework and method come from the entry.
 */
function serviceDoc(
  servers: Array<{ component: string; framework?: string; method: string; path: string }>,
  requests: Array<{ method: string; path: string }>,
): IRDocument {
  const client = "apps/web/src/api.ts";
  const nodes: IRNode[] = [file(client), fn(client, "load")];
  const edges: IRDocument["edges"] = [];
  requests.forEach((r, i) => {
    nodes.push(effect(client, "load", 3 + i, "effects.net.connect", net("fetch", { relative: true, path: r.path, method: r.method })));
  });
  servers.forEach((s, i) => {
    const sfile = `${s.component}/src/routes.ts`;
    nodes.push(file(sfile), fn(sfile, "register"));
    nodes.push(effect(sfile, "register", 4 + i, "effects.net.serve", { framework: s.framework ?? "fastify", method: s.method, path: s.path, handler: "h" }));
  });
  return { nodes, edges, findings: [] };
}

/** The components an apps/web request edge reaches, for one request. */
function requestTargets(sys: SystemModel): string[] {
  return sys.edges.filter((e) => e.verb === "requests" && e.from === "apps/web").map((e) => e.to);
}

describe("route matcher: literal segments and methods", () => {
  it("treats a :param glued to a literal (a query string appended) as that literal", () => {
    const doc = serviceDoc(
      [{ component: "apps/server", method: "GET", path: "/api/projects/:id/review" }],
      [{ method: "GET", path: "/api/projects/:param/review:param" }],
    );
    const sys = systemModel(modelOf(doc), "apps");
    expect(requestTargets(sys)).toEqual(["apps/server"]);
    expect(sys.edges.find((e) => e.verb === "requests")?.label).toBe("GET /api/projects/:id/review");
    expect(sys.externals.some((e) => e.id.startsWith("api:"))).toBe(false);
  });

  it("matches a route whose method is * or ALL for any client method", () => {
    const doc = serviceDoc(
      [
        { component: "apps/hooks", method: "*", path: "/api/hooks" },
        { component: "apps/any", method: "ALL", path: "/api/any" },
      ],
      [
        { method: "POST", path: "/api/hooks" },
        { method: "DELETE", path: "/api/any" },
      ],
    );
    const sys = systemModel(modelOf(doc), "apps");
    expect(requestTargets(sys).sort()).toEqual(["apps/any", "apps/hooks"]);
  });

  it("matches a trailing * route segment to the rest of the path when the route has a literal segment", () => {
    const doc = serviceDoc(
      [{ component: "apps/files", method: "GET", path: "/api/files/*" }],
      [{ method: "GET", path: "/api/files/a/b/c" }],
    );
    const sys = systemModel(modelOf(doc), "apps");
    expect(requestTargets(sys)).toEqual(["apps/files"]);
  });

  it("does not match a trailing * route that has no literal segment", () => {
    const doc = serviceDoc(
      [{ component: "apps/catchall", method: "GET", path: "/*" }],
      [{ method: "GET", path: "/anything" }],
    );
    const sys = systemModel(modelOf(doc), "apps");
    expect(requestTargets(sys)).toEqual(["api:GET /anything"]);
  });

  it("never answers a relative request with a worker route, which is on another origin", () => {
    const doc = serviceDoc(
      [{ component: "apps/worker", framework: "worker", method: "GET", path: "/api/status" }],
      [{ method: "GET", path: "/api/status" }],
    );
    const sys = systemModel(modelOf(doc), "apps");
    expect(requestTargets(sys)).toEqual(["api:GET /api/status"]);
  });
});

describe("route matcher: tie-break among matching routes", () => {
  it("prefers the route with more literal segments, whatever its id order", () => {
    // apps/aaa's route sorts first by id but has a :id wildcard; apps/zzz's literal route is the better match.
    const doc = serviceDoc(
      [
        { component: "apps/aaa", method: "GET", path: "/api/items/:id" },
        { component: "apps/zzz", method: "GET", path: "/api/items/new" },
      ],
      [{ method: "GET", path: "/api/items/new" }],
    );
    const sys = systemModel(modelOf(doc), "apps");
    expect(requestTargets(sys)).toEqual(["apps/zzz"]);
  });

  it("prefers the exact method over * when the literal counts are equal", () => {
    const doc = serviceDoc(
      [
        { component: "apps/aaa", method: "*", path: "/api/x" },
        { component: "apps/zzz", method: "GET", path: "/api/x" },
      ],
      [{ method: "GET", path: "/api/x" }],
    );
    const sys = systemModel(modelOf(doc), "apps");
    expect(requestTargets(sys)).toEqual(["apps/zzz"]);
  });

  it("falls back to the lower route id when literal counts and methods tie", () => {
    const doc = serviceDoc(
      [
        { component: "apps/zzz", method: "GET", path: "/api/y" },
        { component: "apps/aaa", method: "GET", path: "/api/y" },
      ],
      [{ method: "GET", path: "/api/y" }],
    );
    const sys = systemModel(modelOf(doc), "apps");
    expect(requestTargets(sys)).toEqual(["apps/aaa"]);
  });
});

describe("deploy roots", () => {
  it("makes a folder with wrangler.toml and no package.json its own component", () => {
    const doc: IRDocument = {
      nodes: [
        file("apps/web/package.json"),
        file("apps/web/src/a.ts"),
        fn("apps/web/src/a.ts", "run"),
        file("apps/storage-worker/wrangler.toml"),
        file("apps/storage-worker/src/index.ts"),
        fn("apps/storage-worker/src/index.ts", "handle"),
      ],
      edges: [],
      findings: [],
    };
    const sys = systemModel(modelOf(doc), "");
    expect(sys.components.map((c) => [c.id, c.kind])).toEqual([
      ["apps/storage-worker", "package"],
      ["apps/web", "package"],
    ]);
  });
});

describe("database driver stores", () => {
  const span = (path: string) => fx.span(path, 0, 0, 0, 20);
  const unresolved = (from: string, text: string, typeOnly: boolean) =>
    fx.edge(from, { unresolved: { scheme: "module", text } }, "packaging", "packaging.import", { span: span(from), attrs: { specifier: text, typeOnly, dynamic: false } });

  const DB = "apps/server/src/db.ts";
  const IDX = "apps/server/src/index.ts";
  function serverDoc(extraEdges: IRDocument["edges"] = []): IRDocument {
    return {
      nodes: [
        file("apps/server/package.json"),
        file(DB),
        file(IDX),
        fn(DB, "open"),
        fn(IDX, "main"),
      ],
      edges: [unresolved(DB, "better-sqlite3", false), ...extraEdges],
      findings: [],
    };
  }

  it("adds the SQLite store for a runtime better-sqlite3 import, with an opens edge from the importing component", () => {
    const sys = systemModel(modelOf(serverDoc()), "");
    expect(sys.externals).toContainEqual({ id: "store:sqlite", label: "SQLite", category: "store" });
    const edge = sys.edges.find((e) => e.to === "store:sqlite");
    // The model is grounded (main makes an unthreaded runtime), so the edge starts at the importing component's slice.
    const from = sys.slices?.find((sl) => sl.id === edge?.from)?.component ?? edge?.from;
    expect(from).toBe("apps/server");
    expect(edge).toMatchObject({ verb: "opens", label: "better-sqlite3", count: 1 });
    expect(edge?.sites).toEqual([{ file: DB, line: 1 }]);
  });

  it("ignores a type-only import of a driver", () => {
    const sys = systemModel(modelOf(serverDoc([unresolved(IDX, "pg", true)])), "");
    expect(sys.externals.map((e) => e.id)).toEqual(["store:sqlite"]);
    expect(sys.edges.some((e) => e.to === "store:postgresql")).toBe(false);
  });

  it("maps a driver subpath to its store, and a similar package name to nothing", () => {
    expect(storeDriverOf("pg/lib/x")?.label).toBe("PostgreSQL");
    expect(storeDriverOf("@vercel/kv/x")?.label).toBe("Vercel KV");
    expect(storeDriverOf("pg-pool")).toBeUndefined();
    expect(storeDriverOf("node:sqlite")?.id).toBe("store:sqlite");
  });
});

describe("store access facts", () => {
  const KV_WORKER = "apps/storage-worker/src/index.ts";
  const HOSTED = "apps/hosted/src/api.ts";
  const kvRest = "/client/v4/accounts/acc/storage/kv/namespaces/ns/values/key";

  function storeDoc(extra: IRNode[] = [], storeEdges: IRNode[] = []): IRDocument {
    return {
      nodes: [
        file("apps/storage-worker/wrangler.toml"),
        file(KV_WORKER),
        fn(KV_WORKER, "handle"),
        file("apps/hosted/package.json"),
        file(HOSTED),
        fn(HOSTED, "save"),
        ...storeEdges,
        ...extra,
      ],
      edges: [],
      findings: [],
    };
  }
  const access = (attrs: Record<string, unknown>, line = 3) => effect(KV_WORKER, "handle", line, "effects.store.access", attrs);
  const rest = (method: string, line = 4) =>
    effect(HOSTED, "save", line, "effects.net.connect", { api: "fetch", host: "api.cloudflare.com", path: kvRest, method, confidence: "exact" });

  it("gives a KV binding read and a KV REST PUT one external, with reads and writes edges", () => {
    const sys = systemModel(modelOf(storeDoc([rest("PUT")], [access({ api: "env.INDEX", store: "cloudflare-kv", op: "read", binding: "INDEX" })])), "");
    const kv = sys.externals.filter((e) => e.id === "svc:cloudflare-kv");
    expect(kv).toHaveLength(1);
    expect(kv[0]).toMatchObject({ label: "Cloudflare KV", category: "store" });
    const to = sys.edges.filter((e) => e.to === "svc:cloudflare-kv");
    expect(to.map((e) => e.verb).sort()).toEqual(["reads", "writes"]);
    expect(kv[0]?.names).toEqual(["INDEX"]);
    expect(sys.externals.some((e) => e.id.startsWith("host:api.cloudflare.com"))).toBe(false);
  });

  it("uses the writes verb for a write or delete op", () => {
    const sys = systemModel(modelOf(storeDoc([], [access({ api: "env.INDEX", store: "cloudflare-kv", op: "delete", binding: "INDEX" })])), "");
    expect(sys.edges.find((e) => e.to === "svc:cloudflare-kv")?.verb).toBe("writes");
  });

  it("maps D1 to its store and an unknown store to store:<store>", () => {
    const sys = systemModel(
      modelOf(storeDoc([], [access({ api: "env.DB", store: "cloudflare-d1", op: "list" }, 3), access({ api: "x", store: "turso", op: "write" }, 5)])),
      "",
    );
    expect(sys.externals).toEqual(expect.arrayContaining([expect.objectContaining({ id: "store:cloudflare-d1", label: "Cloudflare D1", category: "store" })]));
    expect(sys.externals).toEqual(expect.arrayContaining([expect.objectContaining({ id: "store:turso", label: "turso", category: "store" })]));
    expect(sys.edges.find((e) => e.to === "store:turso")?.verb).toBe("writes");
    expect(sys.edges.find((e) => e.to === "store:cloudflare-d1")?.verb).toBe("reads");
  });

  it("keeps a wrangler-only folder as a pipeline component", () => {
    const frontA = "plugins/a/src/a.ts";
    const host = "host/src/run.ts";
    const doc: IRDocument = {
      nodes: [
        file("host/package.json"),
        file(host),
        fn(host, "run"),
        file("plugins/a/package.json"),
        file(frontA),
        fn(frontA, "detect"),
        file("workers/edge/wrangler.toml"),
        file("workers/edge/src/index.ts"),
        fn("workers/edge/src/index.ts", "detect"),
      ],
      edges: [
        fx.edge(`${host}#run`, [`${frontA}#detect`, "workers/edge/src/index.ts#detect"], "calls", "calls.call", {
          span: fx.span(host, 10, 2, 10, 20),
          attrs: { callee: "frontend.detect", how: "interface" },
        }),
        fx.edge(`${host}#run`, [`${frontA}#detect`, "workers/edge/src/index.ts#detect"], "calls", "calls.call", {
          span: fx.span(host, 11, 2, 11, 20),
          attrs: { callee: "frontend.extract", how: "interface" },
        }),
      ],
      findings: [],
    };
    const pm = pipelineModel(modelOf(doc), "");
    expect(pm.components.map((c) => c.id)).toContain("workers/edge");
  });
});
