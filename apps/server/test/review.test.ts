import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, type InsightServer } from "../src/index.js";

// Compare, review and annotation endpoints on a real git project with two commits. The hand-written
// lock-order fixture gives the lock-order lens a cycle in the head commit that the base does not have.
const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const SCRATCH = resolve(import.meta.dirname, "..", ".insight-test-review");
const REPO = join(SCRATCH, "repo");
const CYCLE_KEY = "lens-lock-order#cycle:accounts_mu|audit_mu";
const CYCLE_ID = "cycle:accounts_mu|audit_mu";

function git(args: string[]): void {
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd: REPO, stdio: "ignore" });
}

let server: InsightServer;
let id: string;

beforeAll(async () => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(REPO, { recursive: true });
  cpSync(join(repoRoot, "samples", "lock-order-fixture"), REPO, { recursive: true });
  git(["init", "-q", "-b", "main"]);
  const ledger = join(REPO, "src", "ledger.cc");
  const headText = readFileSync(ledger, "utf8");
  writeFileSync(
    ledger,
    headText.replace(
      "std::lock_guard<std::mutex> b(audit_mu);\n  std::lock_guard<std::mutex> a(accounts_mu);",
      "std::lock_guard<std::mutex> a(accounts_mu);\n  std::lock_guard<std::mutex> b(audit_mu);",
    ),
  );
  git(["add", "src/ledger.cc"]);
  git(["commit", "-q", "-m", "base"]);
  writeFileSync(ledger, headText);
  git(["commit", "-q", "-am", "head"]);

  server = await buildServer({ home: join(SCRATCH, "home"), intervalMs: 0, webDist: null, autostart: false });
  const added = await server.app.inject({ method: "POST", url: "/api/projects", payload: { path: REPO, name: "repo" } });
  expect(added.statusCode).toBe(201);
  id = added.json().project.id;
  await server.jobs.whenIdle(id);
});

afterAll(async () => {
  await server?.close();
  rmSync(SCRATCH, { recursive: true, force: true });
});

const call = (method: string, url: string, payload?: unknown) => server.app.inject({ method: method as "GET", url, payload: payload as object });

describe("compare endpoint", () => {
  it("returns the lock-order cycle as added in head", async () => {
    const res = await call("GET", `/api/projects/${id}/compare?base=HEAD~1&head=HEAD`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.base.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(body.head.commit).not.toBe(body.base.commit);
    expect(body.base.root).toBeUndefined();
    const lock = body.diff.lenses.find((l: { id: string }) => l.id === "lens-lock-order");
    expect(lock.added.map((f: { id: string }) => f.id)).toEqual([CYCLE_ID]);
  });

  it("answers 400 when a ref is missing or is not a commit", async () => {
    expect((await call("GET", `/api/projects/${id}/compare?base=HEAD~1`)).statusCode).toBe(400);
    const bad = await call("GET", `/api/projects/${id}/compare?base=no-such-ref&head=HEAD`);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/not a commit/);
  });

  it("answers 400 for a folder that is not a git checkout", async () => {
    const plain = join(SCRATCH, "plain");
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, "a.txt"), "x\n");
    const added = await server.app.inject({ method: "POST", url: "/api/projects", payload: { path: plain, name: "plain", index: false } });
    const plainId = added.json().project.id;
    const res = await call("GET", `/api/projects/${plainId}/compare?base=HEAD&head=HEAD`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not a git checkout/);
    await call("DELETE", `/api/projects/${plainId}`);
  });
});

describe("review endpoints", () => {
  it("lists the head snapshot's findings as open", async () => {
    const res = await call("GET", `/api/projects/${id}/review`);
    expect(res.statusCode).toBe(200);
    const cycle = res.json().items.find((i: { key: string }) => i.key === CYCLE_KEY);
    expect(cycle).toMatchObject({ lens: "lens-lock-order", status: "open" });
  });

  it("refuses a dismissal without a note, and accepts one with a note", async () => {
    const bare = await call("PUT", `/api/projects/${id}/review`, { key: CYCLE_KEY, status: "dismissed", note: "  " });
    expect(bare.statusCode).toBe(400);
    const ok = await call("PUT", `/api/projects/${id}/review`, { key: CYCLE_KEY, status: "dismissed", note: "single caller at shutdown" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().decision).toMatchObject({ status: "dismissed", note: "single caller at shutdown" });
    const list = await call("GET", `/api/projects/${id}/review`);
    expect(list.json().items.find((i: { key: string }) => i.key === CYCLE_KEY)).toMatchObject({ status: "dismissed" });
  });

  it("reopens a finding on delete, and rejects a delete with no key", async () => {
    expect((await call("DELETE", `/api/projects/${id}/review`)).statusCode).toBe(400);
    expect((await call("DELETE", `/api/projects/${id}/review?key=${encodeURIComponent(CYCLE_KEY)}`)).statusCode).toBe(204);
    const list = await call("GET", `/api/projects/${id}/review`);
    expect(list.json().items.find((i: { key: string }) => i.key === CYCLE_KEY)).toMatchObject({ status: "open" });
  });

  it("lists a decision whose finding is gone as stale", async () => {
    await call("PUT", `/api/projects/${id}/review`, { key: "lens-calls#unreachable:gone", status: "accepted", note: "" });
    const list = await call("GET", `/api/projects/${id}/review`);
    expect(list.json().stale.map((s: { key: string }) => s.key)).toContain("lens-calls#unreachable:gone");
    await call("DELETE", `/api/projects/${id}/review?key=${encodeURIComponent("lens-calls#unreachable:gone")}`);
  });
});

describe("annotation endpoints", () => {
  let annId: string;

  it("adds, lists and filters annotations", async () => {
    const added = await call("POST", `/api/projects/${id}/annotations`, { type: "node", key: "src/ledger.cc#transfer", text: "takes two locks" });
    expect(added.statusCode).toBe(201);
    annId = added.json().annotation.id;
    await call("POST", `/api/projects/${id}/annotations`, { type: "finding", key: CYCLE_KEY, text: "ticket 42" });
    const all = await call("GET", `/api/projects/${id}/annotations`);
    expect(all.json().annotations).toHaveLength(2);
    const onNode = await call("GET", `/api/projects/${id}/annotations?type=node&key=${encodeURIComponent("src/ledger.cc#transfer")}`);
    expect(onNode.json().annotations.map((a: { id: string }) => a.id)).toEqual([annId]);
  });

  it("rejects a bad target type or empty text", async () => {
    expect((await call("POST", `/api/projects/${id}/annotations`, { type: "file", key: "x", text: "y" })).statusCode).toBe(400);
    expect((await call("POST", `/api/projects/${id}/annotations`, { type: "node", key: "x", text: "" })).statusCode).toBe(400);
  });

  it("edits a note, then deletes it, and answers 404 for an unknown id", async () => {
    const edited = await call("PATCH", `/api/projects/${id}/annotations/${annId}`, { text: "takes two locks, in order" });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().annotation.text).toBe("takes two locks, in order");
    expect((await call("PATCH", `/api/projects/${id}/annotations/nope`, { text: "x" })).statusCode).toBe(404);
    expect((await call("DELETE", `/api/projects/${id}/annotations/${annId}`)).statusCode).toBe(204);
    expect((await call("DELETE", `/api/projects/${id}/annotations/${annId}`)).statusCode).toBe(404);
  });
});
