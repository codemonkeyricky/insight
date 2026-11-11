import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { IRNode } from "@insight/ir";
import frontend from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "net-routes");
const files = [
  "src/client.ts",
  "src/server.ts",
  "src/handlers.ts",
  "src/map.ts",
  "src/wrap.ts",
  "src/many.ts",
  "src/alias.ts",
  "src/worker.ts",
  "src/worker2.ts",
  "src/kv.ts",
];
const root = { path: fixtureRoot, name: "net-routes", allowBuildTools: false };
const readFile = async (rel: string) => readFileSync(join(fixtureRoot, rel), "utf8");

/** Every effect node the frontend emits for the net-routes fixture. */
async function effectNodes(): Promise<IRNode[]> {
  const ctx = { root, files, listFiles: () => [...files], readFile, log: () => undefined };
  const out: IRNode[] = [];
  for await (const batch of frontend.extract(ctx)) {
    for (const record of batch.records) {
      if ("node" in record && record.node.facet === "effects") out.push(record.node);
    }
  }
  return out;
}

/** The attrs of each effects.net.connect node, keyed by the function it sits in. */
function connects(nodes: IRNode[]): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const n of nodes) {
    if (n.kind !== "effects.net.connect") continue;
    out[String(n.parent).split("#")[1] ?? String(n.parent)] = n.attrs ?? {};
  }
  return out;
}

describe("effects.net.connect from fetch", () => {
  it("reads a global fetch with a literal URL and an explicit method as exact", async () => {
    expect(connects(await effectNodes()).postLiteral).toEqual({
      api: "fetch",
      host: "api.github.com",
      path: "/repos/o/r/issues",
      method: "POST",
      confidence: "exact",
    });
  });

  it("writes a template substitution as :param in the path", async () => {
    expect(connects(await effectNodes()).templated).toEqual({
      api: "fetch",
      host: "api.github.com",
      path: "/repos/:param/:param/releases",
      method: "GET",
      confidence: "exact",
    });
  });

  it("marks a relative URL as relative with no host", async () => {
    expect(connects(await effectNodes()).relative).toEqual({
      api: "fetch",
      relative: true,
      path: "/api/index",
      method: "POST",
      confidence: "exact",
    });
  });

  it("reads an env-driven URL through an import.meta.env const", async () => {
    expect(connects(await effectNodes()).fromEnv).toEqual({
      api: "fetch",
      host: "<dynamic>",
      env: "VITE_API_BASE",
      path: "/v1/items/:param",
      method: "GET",
      confidence: "exact",
    });
  });

  it("infers an injected fetch by name, with the URL unknown", async () => {
    expect(connects(await effectNodes()).injected).toEqual({
      api: "deps.fetch",
      host: "<dynamic>",
      method: "PUT",
      confidence: "inferred",
    });
  });

  it("reads the URL of new URL(literal)", async () => {
    expect(connects(await effectNodes()).parsed).toEqual({
      api: "fetch",
      host: "api.github.com",
      path: "/x",
      method: "GET",
      confidence: "exact",
    });
  });
});

describe("effects.net.connect from a fetch-named injection", () => {
  it("reads a fetchFn call whose URL template substitutes a same-file string const", async () => {
    expect(connects(await effectNodes()).viaFetchFn).toEqual({
      api: "fetchFn",
      host: "api.cloudflare.com",
      path: "/client/v4/accounts/:param",
      method: "PUT",
      confidence: "inferred",
    });
  });
});

describe("effects.net.serve", () => {
  it("reads a fastify route registered in a function, with its handler", async () => {
    const serve = (await effectNodes()).filter((n) => n.kind === "effects.net.serve" && n.span?.file === "src/server.ts");
    const post = serve.find((n) => n.attrs?.method === "POST");
    expect(post?.attrs).toEqual({ framework: "fastify", method: "POST", path: "/api/projects/:id/reindex", handler: "reindex" });
    expect(String(post?.parent)).toBe("src/server.ts#register");
  });

  it("reads app.route({method, url}) at module top level", async () => {
    const serve = (await effectNodes()).filter((n) => n.kind === "effects.net.serve" && n.span?.file === "src/server.ts");
    const get = serve.find((n) => n.attrs?.method === "GET");
    expect(get?.attrs).toEqual({ framework: "fastify", method: "GET", path: "/x" });
    expect(String(get?.parent)).toBe("src/server.ts#(module)");
  });

  it("reads an exported HTTP verb as framework export with no path", async () => {
    const serve = (await effectNodes()).filter((n) => n.kind === "effects.net.serve" && n.span?.file === "src/handlers.ts");
    expect(serve.map((n) => n.attrs)).toEqual([
      { framework: "export", method: "POST", path: "" },
      { framework: "export", method: "GET", path: "" },
    ]);
  });

  it("does not read map.get(path) as a route in a file with no server framework", async () => {
    const serve = (await effectNodes()).filter((n) => n.kind === "effects.net.serve" && n.span?.file === "src/map.ts");
    expect(serve).toEqual([]);
  });
});

/** The effects.net.connect nodes that went through a wrapper, with the wrapper's name, as attrs keyed by caller. */
function viaNodes(nodes: IRNode[], wrapper: string): IRNode[] {
  return nodes.filter((n) => n.kind === "effects.net.connect" && n.attrs?.via === wrapper);
}

describe("wrapper propagation (one level)", () => {
  it("emits one node per resolved call site, owned by the caller, with the method passed through", async () => {
    const via = viaNodes(await effectNodes(), "call");
    expect(via.map((n) => n.parent)).toEqual(["src/wrap.ts#callers", "src/wrap.ts#callers"]);
    expect(via.map((n) => n.attrs).sort((a, b) => String(a.path).localeCompare(String(b.path)))).toEqual([
      { api: "fetch", relative: true, path: "/api/items", method: "GET", confidence: "exact", via: "call" },
      { api: "fetch", relative: true, path: "/api/projects/:param/reindex", method: "POST", confidence: "exact", via: "call" },
    ]);
  });

  it("emits nothing for a call site whose argument is not resolvable, and keeps the wrapper's own dynamic node", async () => {
    const nodes = await effectNodes();
    const wrapperNode = nodes.find((n) => n.kind === "effects.net.connect" && n.parent === "src/wrap.ts#call");
    expect(wrapperNode?.attrs).toMatchObject({ api: "fetch", host: "<dynamic>" });
    expect(nodes.filter((n) => n.kind === "effects.net.connect" && n.attrs?.via === "call")).toHaveLength(2);
  });

  it("does not resolve a wrapper with more than 100 call sites", async () => {
    expect(viaNodes(await effectNodes(), "many")).toEqual([]);
  });

  it("resolves a wrapper with fewer call sites than the cap, with the method from the wrapper's init literal", async () => {
    const via = viaNodes(await effectNodes(), "few");
    expect(via.map((n) => n.attrs)).toEqual([
      { api: "fetch", relative: true, path: "/api/a", method: "PUT", confidence: "exact", via: "few" },
      { api: "fetch", relative: true, path: "/api/b", method: "PUT", confidence: "exact", via: "few" },
    ]);
  });
});

describe("export alias and Worker routes", () => {
  it("reads export { handle as POST, handle as GET } by the exported names", async () => {
    const serve = (await effectNodes()).filter((n) => n.kind === "effects.net.serve" && n.span?.file === "src/alias.ts");
    expect(serve.map((n) => n.attrs)).toEqual([
      { framework: "export", method: "POST", path: "" },
      { framework: "export", method: "GET", path: "" },
    ]);
  });

  it("reads export default { async fetch() {} } as a Worker route on every path", async () => {
    const serve = (await effectNodes()).filter((n) => n.kind === "effects.net.serve" && n.span?.file === "src/worker.ts");
    expect(serve.map((n) => n.attrs)).toEqual([{ framework: "worker", method: "*", path: "/*" }]);
  });

  it("reads export default { fetch } (shorthand) as a Worker route", async () => {
    const serve = (await effectNodes()).filter((n) => n.kind === "effects.net.serve" && n.span?.file === "src/worker2.ts");
    expect(serve.map((n) => n.attrs)).toEqual([{ framework: "worker", method: "*", path: "/*" }]);
  });
});

describe("URLs through same-file helpers and enclosing consts", () => {
  it("reads fetch(url(key)) through an inner const base and a helper arrow, with the method from the init literal", async () => {
    const kv = (await effectNodes()).filter((n) => n.kind === "effects.net.connect" && n.span?.file === "src/kv.ts");
    const put = kv.find((n) => String(n.parent).endsWith("#kvStore.put"));
    expect(put?.attrs).toEqual({
      api: "fetch",
      host: "api.cloudflare.com",
      path: "/client/v4/accounts/:param/storage/kv/namespaces/:param/values/:param",
      method: "PUT",
      confidence: "exact",
    });
  });

  it("reads a wrapper call whose URL is a helper call, with the method from the caller's init literal", async () => {
    const via = viaNodes(await effectNodes(), "send");
    expect(via.map((n) => n.attrs)).toEqual([
      {
        api: "fetch",
        host: "api.cloudflare.com",
        path: "/client/v4/accounts/:param/storage/kv/namespaces/:param/values/:param",
        method: "DELETE",
        confidence: "exact",
        via: "send",
      },
    ]);
  });
});
