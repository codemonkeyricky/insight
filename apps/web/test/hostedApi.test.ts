import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/apiError";
import {
  hostedApi,
  hostedBaseFor,
  indexBase,
  parseProjectId,
  projectIdOf,
  rawSourceUrl,
  recentIndexes,
  requestIndex,
  IndexRequestError,
  type HostedRef,
} from "../src/hostedApi";

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);
const ROOT = "https://storage.test/";

afterEach(() => vi.unstubAllGlobals());

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** The project.json every read of a project loads first. */
const PROJECT_JSON = { project: { id: "x", name: "x", addedAt: "t", source: { kind: "path", path: "/local" }, allowBuildTools: false, status: "idle", queued: false }, overview: { project: {} } };

describe("hosted project ids", () => {
  it("round-trips dotted and hyphenated names", () => {
    const refs: HostedRef[] = [
      { owner: "codemonkeyricky", repo: "insight", sha: SHA },
      { owner: "my-org", repo: "socket.io", sha: SHA2 },
      { owner: "a", repo: "node-red.js_v2", sha: SHA },
    ];
    for (const ref of refs) {
      const id = projectIdOf(ref);
      expect(id).toBe(`gh~${ref.owner}~${ref.repo}~${ref.sha}`);
      expect(parseProjectId(id)).toEqual(ref);
    }
  });

  it("refuses ids that are not a hosted commit", () => {
    expect(parseProjectId("gh~o~r")).toBeUndefined();
    expect(parseProjectId(`gh~o~r~${SHA}~x`)).toBeUndefined();
    expect(parseProjectId(`hub~o~r~${SHA}`)).toBeUndefined();
    expect(parseProjectId(`gh~o~r~${"A".repeat(40)}`)).toBeUndefined();
    expect(parseProjectId(`gh~o~r~abc`)).toBeUndefined();
    expect(parseProjectId(`gh~Owner~r~${SHA}`)).toBeUndefined();
    expect(parseProjectId(`gh~o~..~${SHA}`)).toBeUndefined();
    expect(parseProjectId(`gh~-o~r~${SHA}`)).toBeUndefined();
  });

  it("names a commit's files under the storage root", () => {
    const base = hostedBaseFor(ROOT)(projectIdOf({ owner: "codemonkeyricky", repo: "insight", sha: SHA }));
    expect(base).toBe(`${ROOT}gh/codemonkeyricky/insight/${SHA}/`);
    expect(indexBase(ROOT, { owner: "o", repo: "r", sha: SHA })).toBe(`${ROOT}gh/o/r/${SHA}/`);
  });

  it("baseFor refuses an id that is not hosted", () => {
    expect(() => hostedBaseFor(ROOT)("demo-id")).toThrow(ApiError);
  });
});

describe("raw source urls", () => {
  it("encodes each path segment, so spaces and # survive", () => {
    const ref = { owner: "o", repo: "r", sha: SHA };
    expect(rawSourceUrl(ref, "src/my dir/a#b.ts")).toBe(`https://raw.githubusercontent.com/o/r/${SHA}/src/my%20dir/a%23b.ts`);
    expect(rawSourceUrl(ref, "README.md")).toBe(`https://raw.githubusercontent.com/o/r/${SHA}/README.md`);
  });
});

describe("hostedApi reads", () => {
  it("lists scope folders and files as unavailable with the root-only reason", async () => {
    const id = projectIdOf({ owner: "rootonly", repo: "lists", sha: SHA });
    const base = `${"/storage/"}gh/rootonly/lists/${SHA}/`;
    const root = {
      snapshot: "s1",
      scope: "",
      kind: "project",
      stats: { nodes: 1, edges: 0, findings: 0, external: 0 },
      facets: [],
      lenses: [
        { id: "lens-a", title: "A", status: "ok", findings: 2, hasContent: true },
        { id: "lens-b", title: "B", status: "unavailable", reason: "no data", findings: null },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === `${base}project.json`) return json(PROJECT_JSON);
        if (url === `${base}scope/@root/lenses.json`) return json(root);
        if (url === `${base}files.json`) return json([{ path: "src/app.ts", size: 1, functions: 0, types: 0, findings: 0 }]);
        return new Response("missing", { status: 404 });
      }),
    );
    const listing = await hostedApi.scopeLenses(id, "src/app.ts");
    expect(listing.kind).toBe("file");
    expect(listing.lenses.map((l) => l.status)).toEqual(["unavailable", "unavailable"]);
    expect(listing.lenses.every((l) => l.reason === "Hosted indexes cover the project root only")).toBe(true);
    const folder = await hostedApi.scopeLenses(id, "src");
    expect(folder.kind).toBe("folder");
    const rootListing = await hostedApi.scopeLenses(id, "");
    expect(rootListing.lenses[0]?.status).toBe("ok");
  });

  it("reads a source file from GitHub once and encodes its path", async () => {
    const id = projectIdOf({ owner: "src", repo: "fetch", sha: SHA });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/project.json")) return json(PROJECT_JSON);
      if (url.endsWith("/src/my%20dir/a%23b.ts")) return new Response("one\ntwo\nthree", { status: 200 });
      return new Response("nope", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const first = await hostedApi.source(id, "src/my dir/a#b.ts", 2, 2, 0);
    expect(first.lines).toEqual(["two"]);
    await hostedApi.source(id, "src/my dir/a#b.ts", 1, 1, 0);
    const rawCalls = fetchMock.mock.calls.filter(([u]) => String(u).startsWith("https://raw.githubusercontent.com/"));
    expect(rawCalls).toHaveLength(1);
    expect(String(rawCalls[0]?.[0])).toBe(`https://raw.githubusercontent.com/src/fetch/${SHA}/src/my%20dir/a%23b.ts`);
  });

  it("answers a file GitHub does not have with 404", async () => {
    const id = projectIdOf({ owner: "src", repo: "missing", sha: SHA });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.endsWith("/project.json") ? json(PROJECT_JSON) : new Response("nope", { status: 404 }))));
    await expect(hostedApi.source(id, "gone.ts", 1, 1)).rejects.toMatchObject({ status: 404 });
  });

  it("refuses writes with 405 and a hosted message", async () => {
    await expect(hostedApi.reindex("gh~o~r~" + SHA)).rejects.toMatchObject({ status: 405 });
    await expect(hostedApi.compare("gh~o~r~" + SHA, "a", "b")).rejects.toThrow("read-only");
  });
});

describe("recent indexes and index requests", () => {
  it("keeps only the entries that parse", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json([
          { repo: "codemonkeyricky/insight", sha: SHA, indexedAt: "2026-11-10T00:00:00Z", nodes: 10, files: 3 },
          { repo: "bad", sha: SHA, indexedAt: "x", nodes: 1, files: 1 },
          { repo: "o/r", sha: "short", indexedAt: "x", nodes: 1, files: 1 },
          { repo: "o/r", sha: SHA, indexedAt: "x", nodes: "many", files: 1 },
        ]),
      ),
    );
    const list = await recentIndexes(ROOT);
    expect(list).toEqual([{ repo: "codemonkeyricky/insight", sha: SHA, indexedAt: "2026-11-10T00:00:00Z", nodes: 10, files: 3 }]);
  });

  it("treats a missing recent file as empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    expect(await recentIndexes(ROOT)).toEqual([]);
  });

  it("posts an index request and returns the reply", async () => {
    const fetchMock = vi.fn(async () => json({ state: "running", repo: "o/r", sha: SHA }, 202));
    vi.stubGlobal("fetch", fetchMock);
    expect(await requestIndex("o/r", SHA)).toEqual({ state: "running", repo: "o/r", sha: SHA });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ repo: "o/r", ref: SHA });
  });

  it("throws the server's code on a 4xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: { code: "too_large", message: "too big" } }, 413)));
    const err = await requestIndex("o/r").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IndexRequestError);
    expect(err).toMatchObject({ status: 413, code: "too_large", message: "too big" });
  });

  it("reports a dropped request as network", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    await expect(requestIndex("o/r")).rejects.toMatchObject({ code: "network" });
  });
});
