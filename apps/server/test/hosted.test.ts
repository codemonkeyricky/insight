import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildServer, githubRepoUrl, HOSTED_LIMITS, type InsightServer } from "../src/index.js";

const SCRATCH = resolve(import.meta.dirname, "..", ".insight-test-hosted");
const ADMIN = "test-admin-token";

/** A tiny TypeScript project: four files, two of them source. */
function writeProject(dir: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "proj", version: "0.0.0", private: true }));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true }, include: ["src"] }),
  );
  writeFileSync(join(dir, "src/a.ts"), `import { b } from "./b.js";\nexport function a(): number {\n  return b() + 1;\n}\n`);
  writeFileSync(join(dir, "src/b.ts"), `export function b(): number {\n  return 2;\n}\n`);
}

/** A project plugin that writes a marker file when it is imported. Its detect returns null, so it adds nothing. */
function addEvilPlugin(dir: string, marker: string): void {
  mkdirSync(join(dir, ".insight", "plugins", "evil"), { recursive: true });
  writeFileSync(
    join(dir, ".insight", "plugins", "evil", "insight-plugin.json"),
    JSON.stringify({ id: "evil", version: "0.1.0", irVersion: "^1.0", files: ["**/*.never"], provides: ["structure"], roles: { frontend: "index.mjs" } }),
  );
  writeFileSync(
    join(dir, ".insight", "plugins", "evil", "index.mjs"),
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "ran");
export default { id: "evil", version: "0.1.0", provides: ["structure"], async detect() { return null; }, async *extract() {} };
`,
  );
}

const dirs = {
  hostedNoPaths: join(SCRATCH, "p-strict"),
  hostedProject: join(SCRATCH, "p-hosted"),
  hostedSymlink: join(SCRATCH, "p-symlink"),
  hostedCapped: join(SCRATCH, "p-capped"),
  localProject: join(SCRATCH, "p-local"),
};
const markers = {
  hosted: join(SCRATCH, "marker-hosted.txt"),
  local: join(SCRATCH, "marker-local.txt"),
};

let strict: InsightServer; // hosted, no local paths, admin token set
let indexed: InsightServer; // hosted, local paths allowed, real indexing, default caps
let capped: InsightServer; // hosted, a file cap of 1
let local: InsightServer; // the default, local server
const servers: InsightServer[] = [];

async function make(home: string, opts: Parameters<typeof buildServer>[0]): Promise<InsightServer> {
  const server = await buildServer({ home: join(SCRATCH, home), intervalMs: 0, webDist: null, autostart: false, ...opts });
  servers.push(server);
  return server;
}

async function addUrl(server: InsightServer, url: string): Promise<string> {
  const res = await server.app.inject({ method: "POST", url: "/api/projects", payload: { url, index: false } });
  expect(res.statusCode).toBe(201);
  return res.json().project.id as string;
}

beforeAll(async () => {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of Object.values(dirs)) writeProject(d);
  addEvilPlugin(dirs.hostedProject, markers.hosted);
  addEvilPlugin(dirs.localProject, markers.local);
  writeFileSync(join(SCRATCH, "outside.txt"), "secret\n");
  symlinkSync(join(SCRATCH, "outside.txt"), join(dirs.hostedSymlink, "src", "escape.ts"));

  strict = await make("home-strict", { hosted: true, allowPaths: false, adminToken: ADMIN });
  indexed = await make("home-indexed", { hosted: true, allowPaths: true, adminToken: ADMIN });
  capped = await make("home-capped", { hosted: true, allowPaths: true, limits: { maxFiles: 1 } });
  local = await make("home-local", {});
});

afterAll(async () => {
  for (const s of servers) await s.close();
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe("hosted: which project sources are accepted", () => {
  it("accepts GitHub repository URLs and normalizes them", async () => {
    const plain = await strict.app.inject({ method: "POST", url: "/api/projects", payload: { url: "https://github.com/codemonkeyricky/insight", index: false } });
    expect(plain.statusCode).toBe(201);
    expect(plain.json().project.source).toEqual({ kind: "git", url: "https://github.com/codemonkeyricky/insight" });

    const messy = await strict.app.inject({ method: "POST", url: "/api/projects", payload: { url: "https://github.com/Some-Owner/Some.Repo.git/", index: false } });
    expect(messy.statusCode).toBe(201);
    expect(messy.json().project.source.url).toBe("https://github.com/Some-Owner/Some.Repo");

    const slash = await strict.app.inject({ method: "POST", url: "/api/projects", payload: { url: "https://github.com/o2/r2/", index: false } });
    expect(slash.statusCode).toBe(201);
  });

  it("refuses a second add of the same repository", async () => {
    const again = await strict.app.inject({ method: "POST", url: "/api/projects", payload: { url: "https://github.com/codemonkeyricky/insight", index: false } });
    expect(again.statusCode).toBe(409);
  });

  it.each([
    ["a file:// URL", "file:///etc/passwd"],
    ["an ssh:// URL", "ssh://git@github.com/o/r.git"],
    ["scp-style ssh", "git@github.com:o/r.git"],
    ["another host", "https://gitlab.com/o/r"],
    ["plain http", "http://github.com/o/r"],
    ["a /tree/ ref", "https://github.com/o/r/tree/main"],
    ["an owner alone", "https://github.com/o"],
    ["a query string", "https://github.com/o/r?x=1"],
    ["a non-URL", "not a url"],
  ])("refuses %s with 400", async (_label, url) => {
    const res = await strict.app.inject({ method: "POST", url: "/api/projects", payload: { url, index: false } });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a local path when paths are not allowed", async () => {
    const res = await strict.app.inject({ method: "POST", url: "/api/projects", payload: { path: dirs.hostedNoPaths, index: false } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/local paths are not accepted/);
  });

  it("the helper itself accepts only the canonical form", () => {
    expect(githubRepoUrl("https://github.com/a/b")).toBe("https://github.com/a/b");
    expect(githubRepoUrl(" https://github.com/a/b.git ")).toBe("https://github.com/a/b");
    expect(() => githubRepoUrl("https://github.com/a/..")).toThrow();
  });
});

describe("hosted: writes that are not offered answer 405", () => {
  let id: string;
  beforeAll(async () => {
    id = await addUrl(strict, "https://github.com/owner/writes");
  });

  it("refuses compare", async () => {
    const res = await strict.app.inject({ method: "GET", url: `/api/projects/${id}/compare?base=a&head=b` });
    expect(res.statusCode).toBe(405);
  });

  it("refuses review writes", async () => {
    const put = await strict.app.inject({ method: "PUT", url: `/api/projects/${id}/review`, payload: { key: "k", status: "accepted" } });
    expect(put.statusCode).toBe(405);
    const del = await strict.app.inject({ method: "DELETE", url: `/api/projects/${id}/review?key=k` });
    expect(del.statusCode).toBe(405);
  });

  it("refuses annotation writes", async () => {
    const post = await strict.app.inject({ method: "POST", url: `/api/projects/${id}/annotations`, payload: { type: "note", key: "k", text: "t" } });
    expect(post.statusCode).toBe(405);
    const patch = await strict.app.inject({ method: "PATCH", url: `/api/projects/${id}/annotations/abc`, payload: { text: "t" } });
    expect(patch.statusCode).toBe(405);
    const del = await strict.app.inject({ method: "DELETE", url: `/api/projects/${id}/annotations/abc` });
    expect(del.statusCode).toBe(405);
  });

  it("still allows annotation reads", async () => {
    const res = await strict.app.inject({ method: "GET", url: `/api/projects/${id}/annotations` });
    expect(res.statusCode).toBe(200);
  });
});

describe("hosted: deleting a project needs the admin token", () => {
  let id: string;
  beforeAll(async () => {
    id = await addUrl(strict, "https://github.com/owner/deletable");
  });

  it("answers 403 without a token, or with a wrong one", async () => {
    const none = await strict.app.inject({ method: "DELETE", url: `/api/projects/${id}` });
    expect(none.statusCode).toBe(403);
    const wrong = await strict.app.inject({ method: "DELETE", url: `/api/projects/${id}`, headers: { authorization: "Bearer nope" } });
    expect(wrong.statusCode).toBe(403);
    const notBearer = await strict.app.inject({ method: "DELETE", url: `/api/projects/${id}`, headers: { authorization: ADMIN } });
    expect(notBearer.statusCode).toBe(403);
    const stillThere = await strict.app.inject({ method: "GET", url: `/api/projects/${id}` });
    expect(stillThere.statusCode).toBe(200);
  });

  it("deletes with the right token", async () => {
    const res = await strict.app.inject({ method: "DELETE", url: `/api/projects/${id}`, headers: { authorization: `Bearer ${ADMIN}` } });
    expect(res.statusCode).toBe(204);
    const gone = await strict.app.inject({ method: "GET", url: `/api/projects/${id}` });
    expect(gone.statusCode).toBe(404);
  });
});

describe("hosted: indexing", () => {
  it("never imports a project's own plugins, and writes no index.sqlite", async () => {
    const res = await indexed.app.inject({ method: "POST", url: "/api/projects", payload: { path: dirs.hostedProject, name: "Hosted" } });
    expect(res.statusCode).toBe(201);
    const id = res.json().project.id as string;
    await indexed.jobs.whenIdle(id);

    const project = (await indexed.app.inject({ method: "GET", url: `/api/projects/${id}` })).json().project;
    expect(project.status).toBe("idle");
    expect(project.last.nodes).toBeGreaterThan(0);
    expect(existsSync(markers.hosted)).toBe(false);

    const stateDir = indexed.registry.get(id)!.stateDir;
    expect(existsSync(join(stateDir, "index.sqlite"))).toBe(false);
    expect(existsSync(join(stateDir, "state.json"))).toBe(true);
  });

  it("refuses a /source or /file path that is a symbolic link out of the project", async () => {
    const res = await indexed.app.inject({ method: "POST", url: "/api/projects", payload: { path: dirs.hostedSymlink, name: "Link" } });
    const id = res.json().project.id as string;
    await indexed.jobs.whenIdle(id);

    const source = await indexed.app.inject({ method: "GET", url: `/api/projects/${id}/source?file=src/escape.ts&start=1&end=1` });
    expect(source.statusCode).toBe(400);
    expect(source.json().error).toMatch(/outside the project/);

    const file = await indexed.app.inject({ method: "GET", url: `/api/projects/${id}/file?path=src/escape.ts` });
    expect(file.statusCode).toBe(400);

    const parent = await indexed.app.inject({ method: "GET", url: `/api/projects/${id}/source?file=../outside.txt&start=1&end=1` });
    expect(parent.statusCode).toBe(400);
    const parentFile = await indexed.app.inject({ method: "GET", url: `/api/projects/${id}/file?path=src/../../outside.txt` });
    expect(parentFile.statusCode).toBe(400);

    const inside = await indexed.app.inject({ method: "GET", url: `/api/projects/${id}/source?file=src/a.ts&start=1&end=1&context=0` });
    expect(inside.statusCode).toBe(200);
  });
});

describe("hosted: the file cap fails the run with a readable reason", () => {
  it("fails the run with the cap message", async () => {
    const res = await capped.app.inject({ method: "POST", url: "/api/projects", payload: { path: dirs.hostedCapped, name: "Capped" } });
    const id = res.json().project.id as string;
    await capped.jobs.whenIdle(id);
    const project = (await capped.app.inject({ method: "GET", url: `/api/projects/${id}` })).json().project;
    expect(project.status).toBe("error");
    expect(project.error).toBe("repo has 4 files; limit 1");
  });

  it("applies the hosted caps by default", () => {
    expect(HOSTED_LIMITS).toEqual({ maxFiles: 10_000, maxFileBytes: 1024 * 1024, maxTotalBytes: 200 * 1024 * 1024 });
  });
});

describe("local server behaviour is unchanged", () => {
  it("accepts ssh, file:// and paths, as before", async () => {
    const ssh = await local.app.inject({ method: "POST", url: "/api/projects", payload: { url: "ssh://git@example.com/r.git", index: false } });
    expect(ssh.statusCode).toBe(201);
    const file = await local.app.inject({ method: "POST", url: "/api/projects", payload: { url: "file:///tmp/none-local", index: false } });
    expect(file.statusCode).toBe(201);
  });

  it("still imports a project's own plugins and writes index.sqlite", async () => {
    const res = await local.app.inject({ method: "POST", url: "/api/projects", payload: { path: dirs.localProject, name: "Local" } });
    expect(res.statusCode).toBe(201);
    const id = res.json().project.id as string;
    await local.jobs.whenIdle(id);
    expect(existsSync(markers.local)).toBe(true);
    expect(existsSync(join(local.registry.get(id)!.stateDir, "index.sqlite"))).toBe(true);
  });

  it("does not require a token to delete, and does not offer 405 on writes", async () => {
    const id = (await addUrl(local, "https://github.com/owner/local-delete")) as string;
    const del = await local.app.inject({ method: "DELETE", url: `/api/projects/${id}` });
    expect(del.statusCode).toBe(204);
    const id2 = (await addUrl(local, "https://github.com/owner/local-write")) as string;
    const put = await local.app.inject({ method: "PUT", url: `/api/projects/${id2}/review`, payload: { key: "k", status: "accepted" } });
    expect(put.statusCode).not.toBe(405);
    const post = await local.app.inject({ method: "POST", url: `/api/projects/${id2}/annotations`, payload: { type: "note", key: "k", text: "t" } });
    expect(post.statusCode).not.toBe(405);
  });
});
