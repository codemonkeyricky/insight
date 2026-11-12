import { describe, expect, it } from "vitest";
import { hashForRepoPath, parseRepoPath } from "../src/hostedRepo";

const key = (r: ReturnType<typeof parseRepoPath>) => (r ? `${r.owner}/${r.repo}${r.scope ? `@${r.scope}` : ""}` : null);

describe("repository path", () => {
  const cases: [string, string | null][] = [
    ["/facebook/zstd", "facebook/zstd"],
    ["/facebook/zstd/", "facebook/zstd"],
    ["/facebook/zstd.git", "facebook/zstd"],
    ["/facebook/zstd.git/", "facebook/zstd"],
    ["/Facebook/ZSTD", "facebook/zstd"],
    ["/github.com/facebook/zstd", "facebook/zstd"],
    ["/www.github.com/facebook/zstd/", "facebook/zstd"],
    ["/https://github.com/facebook/zstd", "facebook/zstd"],
    ["/https:/github.com/facebook/zstd", "facebook/zstd"],
    ["/http://github.com/facebook/zstd.git", "facebook/zstd"],
    ["/facebook/zstd/tree/dev/lib", "facebook/zstd"],
    ["/facebook/zstd/tree/dev", "facebook/zstd"],
    ["/facebook/zstd/blob/dev/README.md", "facebook/zstd"],
    ["/github.com/facebook/zstd/tree/v1.5.6/programs", "facebook/zstd"],
    ["/my-org/socket.io", "my-org/socket.io"],
    ["/owner/my_repo.v2", "owner/my_repo.v2"],
    ["/owner/repo%2Dname", "owner/repo-name"],
    ["/", null],
    ["", null],
    ["/index.html", null],
    ["/facebook", null],
    ["/facebook/", null],
    ["/facebook/zstd/tree", null],
    ["/facebook/zstd/tree/", null],
    ["/facebook/zstd/issues", null],
    ["/facebook/zstd/a/b/c", null],
    ["/api/index", null],
    ["/api/status", null],
    ["/api/health", null],
    ["/assets/index-abc.js", null],
    ["/assets/x/y", null],
    ["/storage/gh/o/r/latest.json", null],
    ["/-owner/repo", null],
    ["/owner-/repo", null],
    ["/own--er/repo", null],
    ["/owner/..", null],
    ["/owner/.", null],
    ["/owner/.git", null],
    ["/owner/repo name", null],
    ["/owner/repo%ZZ", null],
    ["/gitlab.com/o/r", null],
    ["/https://gitlab.com/o/r", null],
    ["/github.com/o", null],
    ["/a".repeat(40), null],
  ];
  for (const [input, want] of cases) {
    it(`${JSON.stringify(input)} -> ${want}`, () => {
      expect(key(parseRepoPath(input))).toBe(want);
    });
  }

  it("reads the ref of a tree link (the first segment) and of owner/repo@ref", () => {
    expect(parseRepoPath("/facebook/zstd/tree/dev/lib")).toEqual({ owner: "facebook", repo: "zstd", ref: "dev" });
    expect(parseRepoPath("/facebook/zstd/tree/dev")).toEqual({ owner: "facebook", repo: "zstd", ref: "dev" });
    expect(parseRepoPath("/facebook/zstd@dev")).toEqual({ owner: "facebook", repo: "zstd", ref: "dev" });
    expect(parseRepoPath("/facebook/zstd@build/insight-plan")).toEqual({ owner: "facebook", repo: "zstd", ref: "build/insight-plan" });
    expect(parseRepoPath("/facebook/zstd@build%2Finsight-plan")).toEqual({ owner: "facebook", repo: "zstd", ref: "build/insight-plan" });
    expect(parseRepoPath("/facebook/zstd@")).toBeNull();
  });

  it("keeps only owner and repo for a blob link", () => {
    expect(parseRepoPath("/facebook/zstd/blob/dev/lib/x.c")).toEqual({ owner: "facebook", repo: "zstd" });
  });

  it("rejects an owner over 39 characters", () => {
    expect(parseRepoPath(`/${"a".repeat(40)}/repo`)).toBeNull();
    expect(parseRepoPath(`/${"a".repeat(39)}/repo`)).toEqual({ owner: "a".repeat(39), repo: "repo" });
  });
});

describe("boot route from a repository path", () => {
  it("moves a repository path to the hash route", () => {
    expect(hashForRepoPath("/facebook/zstd", "")).toBe("/#/gh/facebook/zstd");
    expect(hashForRepoPath("/facebook/zstd/tree/dev/lib", "")).toBe("/#/gh/facebook/zstd@dev");
    expect(hashForRepoPath("/facebook/zstd@a/b", "")).toBe("/#/gh/facebook/zstd@a%2Fb");
    expect(hashForRepoPath("/github.com/sindresorhus/is-plain-obj/tree/main/test", "#")).toBe("/#/gh/sindresorhus/is-plain-obj@main");
    expect(hashForRepoPath("/https://github.com/facebook/zstd", "#/")).toBe("/#/gh/facebook/zstd");
  });

  it("keeps an existing hash route and drops the path", () => {
    expect(hashForRepoPath("/facebook/zstd", "#/projects/abc/view/flow")).toBe("/#/projects/abc/view/flow");
    expect(hashForRepoPath("/facebook/zstd", "#/gh/facebook/zstd")).toBe("/#/gh/facebook/zstd");
  });

  it("leaves other paths alone", () => {
    expect(hashForRepoPath("/", "")).toBeUndefined();
    expect(hashForRepoPath("/index.html", "")).toBeUndefined();
    expect(hashForRepoPath("/api/index", "")).toBeUndefined();
    expect(hashForRepoPath("/facebook", "")).toBeUndefined();
  });
});
