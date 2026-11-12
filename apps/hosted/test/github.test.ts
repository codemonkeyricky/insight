import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ArchiveLimitError, downloadAndExtract, parseRepoInput } from "../src/index.js";
import { FIXTURE, fakeGithub, makeTarball, SHA } from "./helpers.js";

const SCRATCH = mkdtempSync(join(tmpdir(), "hosted-github-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

describe("parseRepoInput", () => {
  const ok: [string, { owner: string; repo: string; ref?: string }][] = [
    ["owner/repo", { owner: "owner", repo: "repo" }],
    ["  Owner/Repo  ", { owner: "owner", repo: "repo" }],
    ["https://github.com/Owner/Repo", { owner: "owner", repo: "repo" }],
    ["https://github.com/owner/repo.git", { owner: "owner", repo: "repo" }],
    ["https://github.com/owner/repo/", { owner: "owner", repo: "repo" }],
    ["https://github.com/owner/repo.git/", { owner: "owner", repo: "repo" }],
    ["https://www.github.com/owner/repo", { owner: "owner", repo: "repo" }],
    ["github.com/owner/repo", { owner: "owner", repo: "repo" }],
    ["https://github.com/owner/repo/tree/main", { owner: "owner", repo: "repo", ref: "main" }],
    ["https://github.com/owner/repo/tree/feature/x", { owner: "owner", repo: "repo", ref: "feature/x" }],
    ["https://github.com/owner/repo/tree/v1.2.3/", { owner: "owner", repo: "repo", ref: "v1.2.3" }],
    ["owner/my.repo_name-2", { owner: "owner", repo: "my.repo_name-2" }],
  ];
  it.each(ok)("normalizes %s", (input, expected) => {
    expect(parseRepoInput(input)).toEqual(expected);
  });

  const bad = [
    "",
    "owner",
    "owner/repo/extra",
    "owner/..",
    "https://gitlab.com/owner/repo",
    "https://github.com/owner",
    "https://github.com/owner/repo/issues",
    "https://github.com/owner/repo/tree",
    "https://github.com/owner/repo?tab=x",
    "http://github.com/owner/repo",
    "file:///etc/passwd",
    "git@github.com:owner/repo.git",
    "https://github.com/-bad/repo",
    "/home/richard/code",
  ];
  it.each(bad)("rejects %s", (input) => {
    expect(() => parseRepoInput(input)).toThrow();
  });
});

describe("downloadAndExtract", () => {
  it("strips the top folder and skips symlinks", async () => {
    const tarball = await makeTarball(FIXTURE, { "src/link.ts": "a.ts" });
    const dir = join(SCRATCH, "symlink");
    const gh = fakeGithub({ "owner/repo": {} }, tarball);
    const res = await downloadAndExtract("owner", "repo", SHA, dir, { maxFiles: 100, maxFileBytes: 1 << 20, maxTotalBytes: 1 << 20 }, gh.fetch);
    expect(existsSync(join(dir, "src/link.ts"))).toBe(false);
    expect(res.skipped).toBeGreaterThanOrEqual(1);
    expect(readFileSync(join(dir, "src/a.ts"), "utf8")).toBe(FIXTURE["src/a.ts"]);
    expect(existsSync(join(dir, "widget-main"))).toBe(false);
    expect(lstatSync(join(dir, "package.json")).isFile()).toBe(true);
  });

  it("fails with ArchiveLimitError past maxFiles", async () => {
    const tarball = await makeTarball(FIXTURE);
    const gh = fakeGithub({ "owner/repo": {} }, tarball);
    await expect(
      downloadAndExtract("owner", "repo", SHA, join(SCRATCH, "capped"), { maxFiles: 1, maxFileBytes: 1 << 20, maxTotalBytes: 1 << 20 }, gh.fetch),
    ).rejects.toBeInstanceOf(ArchiveLimitError);
  });

  it("skips files over maxFileBytes", async () => {
    const tarball = await makeTarball({ "small.ts": "export const x = 1;\n", "big.ts": "x".repeat(5000) });
    const gh = fakeGithub({ "owner/repo": {} }, tarball);
    const dir = join(SCRATCH, "big");
    await downloadAndExtract("owner", "repo", SHA, dir, { maxFiles: 10, maxFileBytes: 1000, maxTotalBytes: 1 << 20 }, gh.fetch);
    expect(existsSync(join(dir, "small.ts"))).toBe(true);
    expect(existsSync(join(dir, "big.ts"))).toBe(false);
  });
});
