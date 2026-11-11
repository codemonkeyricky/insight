import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { IRNode } from "@insight/ir";
import frontend from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "net-routes");
const files = ["src/client.ts", "src/server.ts", "src/handlers.ts", "src/map.ts"];
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
