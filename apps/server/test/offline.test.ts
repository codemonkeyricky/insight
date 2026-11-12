import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { IndexReport } from "@insight/indexer";
import { syncCheckout } from "../src/git.js";
import { JobRunner, type JobEvent } from "../src/jobs.js";
import { ProjectRegistry } from "../src/registry.js";

const scratch = mkdtempSync(join(tmpdir(), "insight-offline-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** A repository with one commit, to stand in for a remote. */
function makeRemote(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "first");
}

/** The remote disappears, which is what an offline machine sees when it pulls. */
const goOffline = (remote: string) => rmSync(remote, { recursive: true, force: true });

const stubReport = { snapshot: "s1", durationMs: 1, nodes: 0, edges: 0, findings: 0, reused: 0, extracted: [], coverage: [], problems: [], lenses: [] };

describe("offline git sync", () => {
  it("keeps the last clone and reports a warning when the pull fails", async () => {
    const remote = join(scratch, "remote-a");
    makeRemote(remote);
    const dir = join(scratch, "clone-a");
    const first = await syncCheckout(remote, dir);
    expect(first.warning).toBeUndefined();

    goOffline(remote);
    const second = await syncCheckout(remote, dir);
    expect(second.commit).toBe(first.commit);
    expect(second.warning).toMatch(/could not update .*indexing the last fetched copy/);
    expect(existsSync(join(dir, "a.ts"))).toBe(true);
  });

  it("is an error when the first clone cannot be made", async () => {
    await expect(syncCheckout(join(scratch, "no-such-remote"), join(scratch, "clone-none"))).rejects.toThrow();
  });

  it("writes the warning to the run log and finishes the run idle, not failed", async () => {
    const remote = join(scratch, "remote-b");
    makeRemote(remote);
    const home = join(scratch, "home-offline");
    const registry = new ProjectRegistry(home);
    const project = registry.add({ url: `file://${remote}` });
    const indexed: string[] = [];
    const jobs = new JobRunner({
      registry,
      intervalMs: 0,
      index: async (opts) => {
        indexed.push(opts.projectPath);
        return stubReport as unknown as IndexReport;
      },
    });
    const events: JobEvent[] = [];
    jobs.subscribe(project.id, (e) => events.push(e));

    jobs.trigger(project.id);
    await jobs.whenIdle(project.id);
    const firstCommit = registry.get(project.id)?.last?.commit;
    expect(firstCommit).toBeDefined();

    goOffline(remote);
    jobs.trigger(project.id);
    await jobs.whenIdle(project.id);

    const after = registry.get(project.id);
    expect(after?.status).toBe("idle");
    expect(after?.error).toBeUndefined();
    expect(after?.last?.commit).toBe(firstCommit);
    expect(indexed).toHaveLength(2);
    const warnings = events.filter((e): e is Extract<JobEvent, { type: "progress" }> => e.type === "progress" && e.line.startsWith("warning:"));
    expect(warnings).toHaveLength(1);
    expect(events.some((e) => e.type === "failed")).toBe(false);
  });
});
