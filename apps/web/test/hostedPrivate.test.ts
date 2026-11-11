import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/apiError";
import {
  authMe,
  expiryMs,
  hostedApi,
  hostedBaseFor,
  IndexRequestError,
  NO_ACCESS,
  parseProjectId,
  privateBase,
  privateRepos,
  projectIdOf,
  readPrivateLatest,
  readStatus,
  requestIndex,
  SIGN_IN_PRIVATE,
  signInUrl,
  signOut,
} from "../src/hostedApi";
import { makeStaticApi } from "../src/staticApi";

const SHA = "a".repeat(40);
const ROOT = "https://storage.test/";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const PROJECT_JSON = { project: { id: "x", name: "x", addedAt: "t", source: { kind: "path", path: "/local" }, allowBuildTools: false, status: "idle", queued: false }, overview: { project: {} } };

describe("private project ids", () => {
  it("round-trips a private id with ghp~ and a public one with gh~", () => {
    const ref = { owner: "my-org", repo: "socket.io", sha: SHA };
    const priv = projectIdOf({ ...ref, private: true });
    expect(priv).toBe(`ghp~my-org~socket.io~${SHA}`);
    expect(parseProjectId(priv)).toEqual({ ...ref, private: true });
    const pub = projectIdOf({ ...ref, private: false });
    expect(pub).toBe(`gh~my-org~socket.io~${SHA}`);
    expect(parseProjectId(pub)).toEqual({ ...ref, private: false });
  });

  it("refuses malformed private ids", () => {
    expect(parseProjectId("ghp~o~r")).toBeUndefined();
    expect(parseProjectId(`ghp~Owner~r~${SHA}`)).toBeUndefined();
    expect(parseProjectId(`ghp~o~r~${"A".repeat(40)}`)).toBeUndefined();
    expect(parseProjectId(`ghx~o~r~${SHA}`)).toBeUndefined();
    expect(parseProjectId(`ghp~o~r~${SHA}~x`)).toBeUndefined();
  });

  it("reads the expiry of a grant as seconds, milliseconds or an ISO time", () => {
    expect(expiryMs(1_800_000_000)).toBe(1_800_000_000_000);
    expect(expiryMs(1_800_000_000_000)).toBe(1_800_000_000_000);
    expect(expiryMs("2026-11-11T00:00:00Z")).toBe(Date.parse("2026-11-11T00:00:00Z"));
    expect(expiryMs("not a time")).toBeUndefined();
    expect(expiryMs(undefined)).toBeUndefined();
  });

  it("names a private commit's base through the grant", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ base: "https://storage.test/p/1/s/private/gh/o/r/x/", expiresAt: "2099-01-01T00:00:00Z" })));
    const base = await hostedBaseFor(ROOT)(projectIdOf({ owner: "o", repo: "r", sha: SHA, private: true }));
    expect(base).toBe("https://storage.test/p/1/s/private/gh/o/r/x/");
  });
});

describe("private grant", () => {
  const grantPath = (owner: string, repo: string) => `/api/private/grant?repo=${encodeURIComponent(`${owner}/${repo}`)}&sha=${SHA}`;

  it("is cached until five minutes before it expires, then fetched again", async () => {
    const now = Date.parse("2026-11-11T00:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const base = "https://storage.test/p/9/sig/private/gh/cache-o/cache-r/" + SHA + "/";
    const fetchMock = vi.fn(async (url: string) => {
      if (url === grantPath("cache-o", "cache-r")) return json({ base, expiresAt: new Date(now + 3_600_000).toISOString() });
      return new Response("nope", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const ref = { owner: "cache-o", repo: "cache-r", sha: SHA, private: true };
    expect(await privateBase(ref)).toBe(base);
    vi.spyOn(Date, "now").mockReturnValue(now + 3_000_000);
    expect(await privateBase(ref)).toBe(base);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.spyOn(Date, "now").mockReturnValue(now + 3_400_000);
    expect(await privateBase(ref)).toBe(base);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends the grant request with the cookie and maps 401 to the sign-in message", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const err = await privateBase({ owner: "signed-out", repo: "r", sha: SHA, private: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, message: "Sign in with GitHub to view this private repository" });
    expect(err).toMatchObject({ message: SIGN_IN_PRIVATE });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: "same-origin" });
  });

  it("maps 404 to the no-access message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    const err = await privateBase({ owner: "no-access", repo: "r", sha: SHA, private: true }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 404, message: "You don't have access to this repository" });
    expect(err).toMatchObject({ message: NO_ACCESS });
  });
});

describe("private reads", () => {
  it("reads a private project's source through /api/private/source, never raw.githubusercontent.com", async () => {
    const base = `https://storage.test/p/2/sig2/private/gh/src-owner/src-repo/${SHA}/`;
    const id = projectIdOf({ owner: "src-owner", repo: "src-repo", sha: SHA, private: true });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("/api/private/grant")) return json({ base, expiresAt: "2099-01-01T00:00:00Z" });
      if (url === `${base}project.json`) return json(PROJECT_JSON);
      if (url.startsWith("/api/private/source?")) return new Response("one\ntwo\nthree", { status: 200 });
      return new Response("nope", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const slice = await hostedApi.source(id, "src/my dir/a#b.ts", 2, 2, 0);
    expect(slice.lines).toEqual(["two"]);
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.startsWith("https://raw.githubusercontent.com/"))).toBe(false);
    const source = new URL(urls.find((u) => u.startsWith("/api/private/source?")) ?? "", "https://arch.test");
    expect(source.searchParams.get("repo")).toBe("src-owner/src-repo");
    expect(source.searchParams.get("sha")).toBe(SHA);
    expect(source.searchParams.get("path")).toBe("src/my dir/a#b.ts");
  });

  it("asks for a private run's status with visibility=private", async () => {
    const fetchMock = vi.fn(async () => json({ repo: "o/r", sha: SHA, state: "running" }));
    vi.stubGlobal("fetch", fetchMock);
    await readStatus({ owner: "o", repo: "r", sha: SHA, private: true });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`/api/status?repo=o%2Fr&sha=${SHA}&visibility=private`);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: "same-origin" });
  });

  it("reads the newest private index, and answers undefined when there is none", async () => {
    const fetchMock = vi.fn(async (url: string) => (url.includes("missing") ? new Response("", { status: 404 }) : json({ repo: "o/r", sha: SHA, indexedAt: "t", nodes: 1, files: 1 })));
    vi.stubGlobal("fetch", fetchMock);
    expect(await readPrivateLatest("o", "r")).toMatchObject({ sha: SHA });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/private/latest?repo=o%2Fr");
    expect(await readPrivateLatest("missing", "r")).toBeUndefined();
  });
});

describe("index requests for private repositories", () => {
  it("returns the visibility of the reply", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ state: "running", repo: "pv/repo", sha: SHA, visibility: "private" }, 202)));
    expect((await requestIndex("pv/repo")).visibility).toBe("private");
  });

  it("gives a private reply a ghp~ project id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ state: "done", repo: "pv/repo", sha: SHA, visibility: "private" }, 200)));
    const project = await hostedApi.add({ url: "pv/repo", allowBuildTools: false });
    expect(project.id).toBe(`ghp~pv~repo~${SHA}`);
  });

  it("gives a public reply a gh~ project id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ state: "done", repo: "pb/repo", sha: SHA, visibility: "public" }, 200)));
    const project = await hostedApi.add({ url: "pb/repo", allowBuildTools: false });
    expect(project.id).toBe(`gh~pb~repo~${SHA}`);
  });

  it("surfaces auth_required with its 401 status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: { code: "auth_required", message: "sign in" } }, 401)));
    const err = await requestIndex("o/r").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IndexRequestError);
    expect(err).toMatchObject({ status: 401, code: "auth_required" });
  });
});

describe("auth client", () => {
  it("reads the signed-in state", async () => {
    const fetchMock = vi.fn(async () =>
      json({ enabled: true, signedIn: true, login: "octo", avatarUrl: "https://avatars.test/1", installUrl: "https://github.com/apps/s/installations/new" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await authMe()).toEqual({
      enabled: true,
      signedIn: true,
      login: "octo",
      avatarUrl: "https://avatars.test/1",
      installUrl: "https://github.com/apps/s/installations/new",
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/auth/me");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: "same-origin" });
  });

  it("treats a failed request as sign-in off", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    expect(await authMe()).toEqual({ enabled: false, signedIn: false });
  });

  it("treats a non-200 answer as sign-in off", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ enabled: true, signedIn: true }, 500)));
    expect(await authMe()).toEqual({ enabled: false, signedIn: false });
  });

  it("posts the sign-out and throws when the server refuses it", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(signOut()).resolves.toBeUndefined();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/auth/logout");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST", credentials: "same-origin" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403 })));
    await expect(signOut()).rejects.toMatchObject({ status: 403 });
  });

  it("lists the repositories and drops entries that do not parse", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          repos: [
            { repo: "o/private-one", private: true, defaultBranch: "main" },
            { repo: "o/public-one", private: false },
            { repo: "bad", private: true },
          ],
          installUrl: "https://github.com/apps/s/installations/new",
        }),
      ),
    );
    const list = await privateRepos();
    expect(list.repos).toEqual([
      { repo: "o/private-one", private: true, defaultBranch: "main" },
      { repo: "o/public-one", private: false },
    ]);
    expect(list.installUrl).toBe("https://github.com/apps/s/installations/new");
  });

  it("builds the sign-in link with the return hash encoded", () => {
    expect(signInUrl("#/gh/o/r")).toBe("/api/auth/login?return=%23%2Fgh%2Fo%2Fr");
  });
});

describe("async base in makeStaticApi", () => {
  const bases: Record<string, string> = { a: "https://async.test/a/", b: "https://async.test/b/" };
  const graph = { snapshot: "s", nodes: [{ id: "n1", kind: "k", facet: "f", attrs: {} }], edges: [], incoming: {} };

  it("loads files from the resolved base and caches the graph per base", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      for (const [id, base] of Object.entries(bases)) {
        if (url === `${base}project.json`) return json({ ...PROJECT_JSON, project: { ...PROJECT_JSON.project, name: id } });
        if (url === `${base}graph.json`) return json(graph);
      }
      return new Response("nope", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = makeStaticApi(async (id) => {
      await Promise.resolve();
      return bases[id] ?? "https://async.test/none/";
    });
    expect((await api.project("a")).name).toBe("a");
    expect((await api.project("b")).name).toBe("b");
    expect((await api.node("a", "n1")).node.id).toBe("n1");
    expect((await api.node("a", "n1")).node.id).toBe("n1");
    expect(fetchMock.mock.calls.filter(([u]) => u === `${bases.a}graph.json`)).toHaveLength(1);
  });

  it("turns a rejected base into a rejected read", async () => {
    const api = makeStaticApi(async () => {
      throw new ApiError(401, "sign in");
    });
    await expect(api.project("anything")).rejects.toMatchObject({ status: 401 });
  });
});
