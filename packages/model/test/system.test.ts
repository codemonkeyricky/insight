import { describe, expect, it } from "vitest";
import type { IRDocument, IRNode } from "@insight/ir";
import { irFixtures as fx } from "@insight/sdk";
import { buildProjectModel, loadModel, serializeModel, systemModel, type SystemModel } from "../src/index.js";

const file = (path: string): IRNode => fx.node(path, "structure", "structure.file", { attrs: { path }, span: fx.span(path, 0, 0, 0, 0) });

function fn(path: string, name: string, attrs: Record<string, unknown> = {}): IRNode {
  return fx.node(`${path}#${name}`, "structure", "structure.function", { attrs: { name, ...attrs }, parent: path, span: fx.span(path, 2, 0, 9, 1) });
}

/** An effect owned by a function: its span is the line of the call. */
function effect(path: string, owner: string, line: number, kind: string, attrs: Record<string, unknown>): IRNode {
  return fx.node(`${path}@${kind}:${line}`, "effects", kind, { attrs, parent: `${path}#${owner}`, span: fx.span(path, line, 2, line, 20) });
}

function call(from: string, to: string, path: string, line: number) {
  return fx.edge(from, to, "calls", "calls.call", { span: fx.span(path, line, 2, line, 12) });
}

const net = (api: string, attrs: Record<string, unknown>) => ({ api, confidence: "exact", ...attrs });

/** Insight-like hosted code: a Vercel handler POSTs to the indexer; the indexer reads GitHub and writes Cloudflare KV. */
const HV = "packages/hosted/src/vercel.ts";
const HI = "packages/hosted/src/indexer.ts";
const HG = "packages/hosted/src/github.ts";
const HS = "packages/hosted/src/storage.ts";

function hostedDoc(): IRDocument {
  const nodes: IRNode[] = [
    file("packages/hosted/package.json"),
    file(HV),
    file(HI),
    file(HG),
    file(HS),
    fn(HV, "POST", { anonymous: false }),
    fn(HI, "indexRepo"),
    fn(HG, "fetchTree"),
    fn(HS, "putKv"),
    effect(HV, "POST", 3, "effects.net.serve", { framework: "export", method: "POST", path: "", handler: "POST" }),
    effect(HI, "indexRepo", 4, "effects.proc.exec", { api: "child_process.spawn", command: "git" }),
    effect(HG, "fetchTree", 4, "effects.net.connect", net("fetch", { host: "api.github.com", path: "/repos/acme/app/git/trees", method: "GET" })),
    effect(HG, "fetchTree", 6, "effects.net.connect", net("fetch", { host: "codeload.github.com", path: "/acme/app/tar.gz/main", method: "GET" })),
    effect(HG, "fetchTree", 8, "effects.env.read", { api: "process.env", name: "GITHUB_TOKEN" }),
    effect(HS, "putKv", 5, "effects.net.connect", net("fetch", { host: "api.cloudflare.com", path: "/client/v4/accounts/:param/storage/kv/namespaces/:param/values/:param", method: "PUT" })),
    effect(HS, "putKv", 6, "effects.env.read", { api: "process.env", name: "CLOUDFLARE_API_TOKEN" }),
    effect(HS, "putKv", 7, "effects.env.read", { api: "process.env", name: "CLOUDFLARE_ACCOUNT_ID" }),
  ];
  const edges = [
    call(`${HV}#POST`, `${HI}#indexRepo`, HV, 3),
    call(`${HI}#indexRepo`, `${HG}#fetchTree`, HI, 5),
    call(`${HI}#indexRepo`, `${HS}#putKv`, HI, 6),
  ];
  return { nodes, edges, findings: [] };
}

function modelOf(doc: IRDocument) {
  return buildProjectModel(doc);
}

function edgeBetween(sys: SystemModel, from: string, to: string) {
  return sys.edges.find((e) => e.from === from && e.to === to);
}

describe("systemModel on the hosted-like fixture", () => {
  const sys = systemModel(modelOf(hostedDoc()), "packages/hosted/src");

  it("makes one component per file of the scope, with the entry point marked", () => {
    expect(sys.components.map((c) => c.id)).toEqual([HG, HI, HS, HV]);
    expect(sys.components.every((c) => c.kind === "file")).toBe(true);
    expect(sys.components.find((c) => c.id === HV)?.entry).toBe(true);
    expect(sys.components.find((c) => c.id === HI)?.entry).toBe(false);
    expect(sys.components.find((c) => c.id === HI)?.functions).toBe(1);
  });

  it("names the external systems with the expected categories and verbs", () => {
    const labels = sys.externals.map((e) => e.label).sort();
    expect(labels).toEqual(["Cloudflare KV", "Environment", "GitHub API", "GitHub codeload", "git"].sort());
    const verbOf = (label: string) => {
      const ext = sys.externals.find((e) => e.label === label);
      return sys.edges.find((e) => e.to === ext?.id)?.verb;
    };
    expect(verbOf("GitHub API")).toBe("reads");
    expect(verbOf("GitHub codeload")).toBe("reads");
    expect(verbOf("Cloudflare KV")).toBe("writes");
    expect(verbOf("git")).toBe("runs");
    expect(sys.externals.find((e) => e.label === "Cloudflare KV")?.category).toBe("store");
    expect(sys.externals.find((e) => e.label === "GitHub API")?.host).toBe("api.github.com");
  });

  it("labels the HTTP edges by method with counts", () => {
    const kv = sys.externals.find((e) => e.label === "Cloudflare KV");
    expect(edgeBetween(sys, HS, kv?.id as string)?.label).toBe("PUT");
    const gh = sys.externals.find((e) => e.label === "GitHub API");
    expect(edgeBetween(sys, HG, gh?.id as string)?.label).toBe("GET");
  });

  it("aggregates env reads by name and lists the names sorted", () => {
    const env = sys.externals.find((e) => e.label === "Environment");
    expect(env?.category).toBe("config");
    expect(env?.names).toEqual(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "GITHUB_TOKEN"]);
    const toEnv = sys.edges.filter((e) => e.to === env?.id);
    expect(toEnv.map((e) => [e.from, e.label])).toEqual([[HG, "1 var"], [HS, "2 vars"]]);
  });

  it("has the component calls, with the calls and imports verbs", () => {
    const handler = edgeBetween(sys, HV, HI);
    expect(handler?.verb).toBe("calls");
    expect(handler?.count).toBe(1);
    expect(handler?.confidence).toBe("exact");
    expect(handler?.sites).toEqual([{ file: HV, line: 4, fn: `${HV}#POST` }]);
    expect(edgeBetween(sys, HI, HG)).toBeDefined();
    expect(edgeBetween(sys, HI, HS)).toBeDefined();
  });

  it("serves the POST route of the handler", () => {
    expect(sys.routes).toHaveLength(1);
    expect(sys.routes[0]).toMatchObject({ component: HV, framework: "export", method: "POST", path: "", handler: "POST" });
  });

  it("orders the stages from the entry point: handler, indexer, then the two systems it calls", () => {
    expect(sys.stages).toEqual([[HV], [HI], [HG, HS]]);
  });

  it("keeps every edge endpoint in the components or the externals", () => {
    const ids = new Set([...sys.components.map((c) => c.id), ...sys.externals.map((e) => e.id)]);
    for (const e of sys.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
  });
});

describe("systemModel rules", () => {
  it("draws package components at the root, with the package.json roots", () => {
    const doc: IRDocument = {
      nodes: [
        file("packages/a/package.json"),
        file("packages/b/package.json"),
        file("packages/a/src/x.ts"),
        file("packages/b/src/y.ts"),
        file("scripts/run.ts"),
        fn("packages/a/src/x.ts", "make"),
        fn("packages/b/src/y.ts", "use"),
        fn("scripts/run.ts", "main"),
      ],
      edges: [call("scripts/run.ts#main", "packages/b/src/y.ts#use", "scripts/run.ts", 3), call("packages/b/src/y.ts#use", "packages/a/src/x.ts#make", "packages/b/src/y.ts", 4)],
      findings: [],
    };
    const sys = systemModel(modelOf(doc), "");
    expect(sys.components.map((c) => [c.id, c.kind])).toEqual([
      ["packages/a", "package"],
      ["packages/b", "package"],
      ["scripts", "folder"],
    ]);
    expect(sys.components.find((c) => c.id === "scripts")?.entry).toBe(true);
    expect(sys.stages[0]).toEqual(["scripts"]);
    expect(sys.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["packages/b>packages/a", "scripts>packages/b"]);
  });

  it("maps a relative fetch to the matching route, with :param segments and a leading substitution", () => {
    const doc: IRDocument = {
      nodes: [
        file("apps/web/src/api.ts"),
        file("apps/server/src/routes.ts"),
        fn("apps/web/src/api.ts", "reindex"),
        fn("apps/server/src/routes.ts", "register"),
        effect("apps/web/src/api.ts", "reindex", 3, "effects.net.connect", net("fetch", { relative: true, path: "/api/projects/:param/reindex", method: "POST" })),
        effect("apps/web/src/api.ts", "reindex", 5, "effects.net.connect", net("fetch", { relative: true, path: "/api/unknown", method: "GET" })),
        effect("apps/web/src/api.ts", "reindex", 7, "effects.net.connect", net("fetch", { relative: true, path: ":param/api/projects/:param/reindex", method: "POST" })),
        effect("apps/server/src/routes.ts", "register", 4, "effects.net.serve", { framework: "fastify", method: "POST", path: "/api/projects/:id/reindex", handler: "reindex" }),
      ],
      edges: [],
      findings: [],
    };
    const sys = systemModel(modelOf(doc), "apps");
    const route = sys.routes[0];
    expect(route).toMatchObject({ component: "apps/server", method: "POST", path: "/api/projects/:id/reindex", framework: "fastify" });
    const toRoute = sys.edges.filter((e) => e.verb === "requests" && e.to === "apps/server");
    expect(toRoute.map((e) => e.label)).toEqual(["POST /api/projects/:id/reindex ×2"]);
    expect(toRoute[0]?.count).toBe(2);
    expect(toRoute[0]?.from).toBe("apps/web");
    const api = sys.externals.find((e) => e.id === "api:GET /api/unknown");
    expect(api).toMatchObject({ label: "GET /api/unknown", category: "api" });
    expect(sys.edges.find((e) => e.to === api?.id)?.verb).toBe("requests");
  });

  it("names an env-driven URL after its variable and an unknown dynamic URL generically", () => {
    const doc: IRDocument = {
      nodes: [file("src/client.ts"), fn("src/client.ts", "load"), effect("src/client.ts", "load", 2, "effects.net.connect", net("fetch", { host: "<dynamic>", env: "VITE_STORAGE_BASE", method: "GET" })), effect("src/client.ts", "load", 3, "effects.net.connect", net("fetch", { host: "<dynamic>", method: "GET" }))],
      edges: [],
      findings: [],
    };
    const sys = systemModel(modelOf(doc), "");
    expect(sys.externals.map((e) => e.label).sort()).toEqual(["Dynamic URL", "URL from VITE_STORAGE_BASE"]);
    expect(sys.externals.find((e) => e.label === "URL from VITE_STORAGE_BASE")?.category).toBe("service");
    expect(sys.edges.every((e) => e.verb === "reads")).toBe(true);
  });

  it("gives each command its own process external, with runs as the verb", () => {
    const doc: IRDocument = {
      nodes: [file("src/a.ts"), fn("src/a.ts", "go"), effect("src/a.ts", "go", 2, "effects.proc.exec", { api: "child_process.spawn", command: "git" }), effect("src/a.ts", "go", 3, "effects.proc.exec", { api: "child_process.exec", command: "tar" }), effect("src/a.ts", "go", 4, "effects.proc.exec", { api: "child_process.exec", command: "<dynamic>" })],
      edges: [],
      findings: [],
    };
    const sys = systemModel(modelOf(doc), "");
    expect(sys.externals.map((e) => [e.label, e.category, e.command])).toEqual([
      ["dynamic command", "process", "dynamic command"],
      ["git", "process", "git"],
      ["tar", "process", "tar"],
    ]);
    expect(sys.edges.map((e) => [e.verb, e.label])).toEqual([
      ["runs", "dynamic command"],
      ["runs", "git"],
      ["runs", "tar"],
    ]);
  });

  it("counts filesystem reads and writes into one filesystem external", () => {
    const doc: IRDocument = {
      nodes: [file("src/a.ts"), fn("src/a.ts", "go"), effect("src/a.ts", "go", 2, "effects.fs.read", { api: "fs.readFile", path: "x" }), effect("src/a.ts", "go", 3, "effects.fs.write", { api: "fs.writeFile", path: "y" })],
      edges: [],
      findings: [],
    };
    const sys = systemModel(modelOf(doc), "");
    expect(sys.externals).toEqual([{ id: "fs", label: "Filesystem", category: "filesystem" }]);
    expect(sys.edges.map((e) => e.verb).sort()).toEqual(["reads", "writes"]);
  });

  it("draws a one-file scope as one component and drops edges to other files", () => {
    const sys = systemModel(modelOf(hostedDoc()), HG);
    expect(sys.scope).toBe(HG);
    expect(sys.components).toHaveLength(1);
    expect(sys.components[0]).toMatchObject({ id: HG, label: "(scope)", kind: "file", entry: false });
    expect(sys.edges.every((e) => e.from === HG)).toBe(true);
    expect(sys.edges.some((e) => e.to === HI || e.to === HS)).toBe(false);
    expect(sys.externals.map((e) => e.label).sort()).toEqual(["Environment", "GitHub API", "GitHub codeload"]);
    expect(sys.stages).toEqual([[HG]]);
  });

  it("gives an empty model for a scope with no files", () => {
    const sys = systemModel(modelOf(hostedDoc()), "no/such/folder");
    expect(sys).toEqual({ scope: "no/such/folder", components: [], routes: [], externals: [], edges: [], stages: [] });
  });

  it("gives an empty model for an empty project", () => {
    expect(systemModel(modelOf({ nodes: [], edges: [], findings: [] }), "")).toEqual({ scope: "", components: [], routes: [], externals: [], edges: [], stages: [] });
  });

  it("is deterministic: the same model gives the same output", () => {
    const a = JSON.stringify(systemModel(modelOf(hostedDoc()), "packages/hosted/src"));
    const b = JSON.stringify(systemModel(modelOf(hostedDoc()), "packages/hosted/src"));
    expect(a).toBe(b);
  });

  it("caps the sites of an edge at 20 but keeps the full count", () => {
    const nodes: IRNode[] = [file("src/a.ts"), file("src/b.ts"), fn("src/a.ts", "many"), fn("src/b.ts", "target")];
    const edges: IRDocument["edges"] = [];
    for (let i = 0; i < 25; i++) edges.push(call("src/a.ts#many", "src/b.ts#target", "src/a.ts", 10 + i));
    const sys = systemModel(modelOf({ nodes, edges, findings: [] }), "src");
    const e = sys.edges[0];
    expect(e?.count).toBe(25);
    expect(e?.sites).toHaveLength(20);
  });
});

describe("older model.json without effect facts", () => {
  it("loads and gives calls-only System edges", () => {
    const doc: IRDocument = {
      nodes: [file("src/a.ts"), file("src/b.ts"), fn("src/a.ts", "a"), fn("src/b.ts", "b")],
      edges: [call("src/a.ts#a", "src/b.ts#b", "src/a.ts", 3)],
      findings: [],
    };
    const old = JSON.parse(JSON.stringify({ schema: 1, snapshot: "old", doc }));
    const loaded = loadModel(old);
    const sys = systemModel(loaded, "src");
    expect(sys.edges.map((e) => [e.from, e.to, e.verb])).toEqual([["src/a.ts", "src/b.ts", "calls"]]);
    expect(sys.externals).toEqual([]);
    expect(sys.routes).toEqual([]);
  });

  it("round-trips the effect facts of a current model", () => {
    const json = JSON.parse(JSON.stringify(serializeModel(modelOf(hostedDoc()), "snap")));
    const a = systemModel(loadModel(json), "packages/hosted/src");
    const b = systemModel(modelOf(hostedDoc()), "packages/hosted/src");
    expect(a).toEqual(b);
  });
});

describe("services catalog", () => {
  it("classifies hosts with path and suffix rules", async () => {
    const { classifyHost } = await import("../src/index.js");
    expect(classifyHost("api.cloudflare.com", "/client/v4/accounts/x/storage/kv/namespaces/y").label).toBe("Cloudflare KV");
    expect(classifyHost("api.cloudflare.com", "/client/v4/zones").label).toBe("Cloudflare API");
    expect(classifyHost("bucket.acc.r2.cloudflarestorage.com").category).toBe("store");
    expect(classifyHost("app.example.workers.dev").category).toBe("worker");
    expect(classifyHost("example.org")).toMatchObject({ label: "example.org", category: "service" });
  });
});

describe("systemModel follow-ups", () => {
  const T = "packages/hosted/test/indexer.test.ts";
  const withTests = (): IRDocument => {
    const doc = hostedDoc();
    doc.nodes.push(file("packages/hosted/tsconfig.json"), file(T), fn(T, "check"));
    doc.edges.push(call(`${T}#check`, `${HI}#indexRepo`, T, 3));
    return doc;
  };

  it("drops children that hold no code (package.json, tsconfig.json)", () => {
    const sys = systemModel(modelOf(withTests()), "packages/hosted", { tests: true });
    expect(sys.components.map((c) => c.id)).not.toContain("packages/hosted/package.json");
    expect(sys.components.map((c) => c.id)).not.toContain("packages/hosted/tsconfig.json");
  });

  it("hides tests by default and includes them with the tests option", () => {
    const hidden = systemModel(modelOf(withTests()), "packages/hosted");
    expect(hidden.components.some((c) => c.path.includes("test"))).toBe(false);
    expect(hidden.edges.every((e) => !e.from.includes("test"))).toBe(true);
    const shown = systemModel(modelOf(withTests()), "packages/hosted", { tests: true });
    expect(shown.components.map((c) => c.id)).toContain("packages/hosted/test");
    expect(shown.edges.some((e) => e.from === "packages/hosted/test")).toBe(true);
  });

  it("shows a scope inside a test folder without the option", () => {
    const sys = systemModel(modelOf(withTests()), "packages/hosted/test");
    expect(sys.components.map((c) => c.id)).toEqual([T]);
  });

  it("descends through a scope that holds one code folder, and names it in via", () => {
    const sys = systemModel(modelOf(withTests()), "packages/hosted");
    expect(sys.scope).toBe("packages/hosted");
    expect(sys.via).toBe("src");
    expect(sys.components.map((c) => c.id)).toEqual([HG, HI, HS, HV]);
    expect(sys.stages).toEqual([[HV], [HI], [HG, HS]]);
  });

  it("sets no via when the scope holds several components", () => {
    expect(systemModel(modelOf(withTests()), "packages/hosted", { tests: true }).via).toBeUndefined();
    expect(systemModel(modelOf(hostedDoc()), "packages/hosted/src").via).toBeUndefined();
  });

  it("descends repeatedly through nested single folders", () => {
    const doc: IRDocument = { nodes: [file("pkg/a/b/x.ts"), file("pkg/a/b/y.ts"), fn("pkg/a/b/x.ts", "x"), fn("pkg/a/b/y.ts", "y")], edges: [call("pkg/a/b/x.ts#x", "pkg/a/b/y.ts#y", "pkg/a/b/x.ts", 3)], findings: [] };
    const sys = systemModel(modelOf(doc), "pkg");
    expect(sys.via).toBe("a/b");
    expect(sys.components.map((c) => c.id)).toEqual(["pkg/a/b/x.ts", "pkg/a/b/y.ts"]);
  });

  it("starts column 0 with routes, main and callers-with-facts; an isolated component goes last", () => {
    const A = "src/a.ts";
    const B = "src/b.ts";
    const C = "src/c.ts";
    const D = "src/d.ts";
    const doc: IRDocument = {
      nodes: [file(A), file(B), file(C), file(D), fn(A, "a"), fn(B, "b"), fn(C, "c"), fn(D, "d"), effect(C, "c", 3, "effects.fs.read", { api: "fs.readFile" })],
      edges: [call(`${A}#a`, `${B}#b`, A, 3)],
      findings: [],
    };
    const sys = systemModel(modelOf(doc), "src");
    // A and C have no callers but facts going out; B is called by A; D has nothing in or out.
    expect(sys.stages).toEqual([[A, C], [B], [D]]);
    expect(sys.components.every((c) => !c.entry)).toBe(true);
  });
});
