import { afterEach, describe, expect, it, vi } from "vitest";
import { makeStaticApi, staticApi } from "../src/staticApi";

afterEach(() => vi.unstubAllGlobals());

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

const projectJson = (name: string) => ({
  project: { id: name, name, addedAt: "t", source: { kind: "path", path: `/src/${name}` }, allowBuildTools: false, status: "idle", queued: false },
  overview: { project: { id: name, name } },
});

describe("makeStaticApi", () => {
  it("reads each project from its own base, with no mixing between projects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "https://factory.test/alpha/project.json") return json(projectJson("alpha"));
        if (url === "https://factory.test/beta/project.json") return json(projectJson("beta"));
        return new Response("nope", { status: 404 });
      }),
    );
    const api = makeStaticApi((id) => `https://factory.test/${id}/`);
    const [a, b] = await Promise.all([api.project("alpha"), api.project("beta")]);
    expect(a.name).toBe("alpha");
    expect(b.name).toBe("beta");
    // A second read of each project comes from its own cache entry, not the other project's.
    expect((await api.project("alpha")).name).toBe("alpha");
    expect((await api.project("beta")).name).toBe("beta");
  });

  it("applies identify to the project and the overview", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(projectJson("gamma"))));
    const api = makeStaticApi(() => "https://factory.test/identify/", {
      identify: (id, project) => ({ ...project, id, name: "owner/gamma", source: { kind: "git", url: "https://github.com/owner/gamma" } }),
    });
    const project = await api.project("gh~owner~gamma~" + "d".repeat(40));
    expect(project).toMatchObject({ name: "owner/gamma", source: { kind: "git" } });
    const overview = await api.overview("gh~owner~gamma~" + "d".repeat(40));
    expect(overview.project.name).toBe("owner/gamma");
  });

  it("uses the demo base for the demo api, unchanged", async () => {
    const fetchMock = vi.fn(async () => json(projectJson("demo")));
    vi.stubGlobal("fetch", fetchMock);
    const project = await staticApi.project("any-id");
    expect(project.name).toBe("demo");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/demo/project.json");
  });
});

describe("makeStaticApi file flow", () => {
  it("lays out a file's function charts from the graph, with no flow file in the export", async () => {
    const span = (file: string) => ({ file, start: [1, 0], end: [3, 1] });
    const graph = {
      snapshot: "snap",
      nodes: [
        { id: "a.ts#f", kind: "structure.function", facet: "structure", attrs: { name: "f" }, span: span("a.ts"), provenance: { confidence: "exact", frontend: "x" } },
        { id: "b.ts#g", kind: "structure.function", facet: "structure", attrs: { name: "g" }, span: span("b.ts"), provenance: { confidence: "exact", frontend: "x" } },
      ],
      edges: [],
      incoming: {},
    };
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        requested.push(url);
        if (url.endsWith("/project.json")) return json(projectJson("flowy"));
        if (url.endsWith("/graph.json")) return json(graph);
        return new Response("nope", { status: 404 });
      }),
    );
    const api = makeStaticApi(() => "https://factory.test/flowy/");
    const flow = await api.flow("flowy", "a.ts");
    expect(flow.file).toBe("a.ts");
    expect(flow.functions.map((f) => f.id)).toEqual(["a.ts#f"]);
    expect(requested.some((u) => u.includes("/flow/"))).toBe(false);
    expect((await api.flow("flowy", "c.ts")).functions).toEqual([]);
  });
});
