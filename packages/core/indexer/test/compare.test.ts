import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checklist,
  compareCommits,
  InputError,
  isGitCheckout,
  projectPaths,
  readReview,
  setDecision,
} from "../src/index.js";

// Two real commits in a scratch repo: the base takes the locks in one order everywhere, the head reverses
// reconcile(), so the lock-order lens should add cycle:accounts_mu|audit_mu between them.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..", "..");
const SCRATCH = join(here, "..", ".insight-test", `compare-${process.pid}`);
const project = join(SCRATCH, "repo");
const CYCLE = "cycle:accounts_mu|audit_mu";
const opts = { builtinRoot: repoRoot, userPluginDir: join(SCRATCH, "no-user-plugins") };

function git(args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], {
    cwd: project,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

beforeAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(project, { recursive: true });
  cpSync(join(repoRoot, "samples", "lock-order-fixture"), project, { recursive: true });
  git(["init", "-q", "-b", "main"]);
  // Base: reconcile takes accounts_mu first, the same order as transfer().
  const ledger = join(project, "src", "ledger.cc");
  const headText = readFileSync(ledger, "utf8");
  writeFileSync(
    ledger,
    headText.replace(
      "std::lock_guard<std::mutex> b(audit_mu);\n  std::lock_guard<std::mutex> a(accounts_mu);",
      "std::lock_guard<std::mutex> a(accounts_mu);\n  std::lock_guard<std::mutex> b(audit_mu);",
    ),
  );
  git(["add", "src/ledger.cc"]);
  git(["commit", "-q", "-m", "base: consistent lock order"]);
  // Head: the fixture as it is, with the reversed order in reconcile().
  writeFileSync(ledger, headText);
  git(["commit", "-q", "-am", "head: reverse the lock order in reconcile"]);
  // An uncommitted edit must not reach either snapshot.
  writeFileSync(ledger, `${headText}\n// local edit, not committed\n`);
});

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe("compare commits", () => {
  it("detects a git checkout and rejects a folder that is not one", () => {
    expect(isGitCheckout(project)).toBe(true);
    expect(isGitCheckout(join(SCRATCH, "no-user-plugins"))).toBe(false);
  });

  it("refuses refs that are not commits, and option-like refs", async () => {
    await expect(compareCommits(project, "no-such-ref", "HEAD", opts)).rejects.toBeInstanceOf(InputError);
    await expect(compareCommits(project, "--output=/tmp/x", "HEAD", opts)).rejects.toBeInstanceOf(InputError);
    await expect(compareCommits(project, "", "HEAD", opts)).rejects.toBeInstanceOf(InputError);
  });

  it("indexes both commits and reports the lock-order cycle as added in head", async () => {
    const result = await compareCommits(project, "HEAD~1", "HEAD", opts);
    expect(result.base.reused).toBe(false);
    expect(result.head.reused).toBe(false);
    expect(result.base.snapshot).not.toBe(result.head.snapshot);

    const lockOrder = result.diff.lenses.find((l) => l.id === "lens-lock-order");
    expect(lockOrder).toMatchObject({ comparable: true, base: "ok", head: "ok" });
    expect(lockOrder?.added.map((f) => f.id)).toEqual([CYCLE]);
    expect(lockOrder?.removed).toEqual([]);
    expect(result.diff.summary).toContain("New lens-lock-order finding (error): " + lockOrder?.added[0]?.message);
  });

  it("does not index the uncommitted edit, so the head snapshot matches the committed file", async () => {
    const head = await compareCommits(project, "HEAD~1", "HEAD", opts);
    expect(head.head.root).toContain(join(".insight", "commits"));
    expect(readFileSync(join(head.head.root, "src", "ledger.cc"), "utf8")).not.toContain("local edit");
  });

  it("reuses commits that were already indexed on the next comparison", async () => {
    const again = await compareCommits(project, "HEAD~1", "HEAD", opts);
    expect(again.base.reused).toBe(true);
    expect(again.head.reused).toBe(true);
    expect(again.head.snapshot).toBe((await compareCommits(project, "HEAD", "HEAD", opts)).head.snapshot);
  });

  it("lets a reviewer dismiss the added cycle with a note, and keeps the decision", async () => {
    const result = await compareCommits(project, "HEAD~1", "HEAD", opts);
    const added = result.diff.lenses.find((l) => l.id === "lens-lock-order")!.added[0]!;
    const paths = projectPaths(project);
    setDecision(paths, added.key, "dismissed", "accepted for the audit thread: reconcile runs only at shutdown");
    const { items } = checklist(
      [{ key: added.key, lens: added.lens, id: added.id, severity: added.severity, message: added.message }],
      readReview(paths),
    );
    expect(items[0]).toMatchObject({ status: "dismissed", note: "accepted for the audit thread: reconcile runs only at shutdown" });
    expect(added.key).toBe(`lens-lock-order#${CYCLE}`);
  });
});
