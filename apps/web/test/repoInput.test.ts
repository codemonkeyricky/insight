import { describe, expect, it } from "vitest";
import { canRetry, hrefHosted, indexErrorText, isRepoName, parseRepoInput, relativeTime } from "../src/hostedRepo";

describe("repository input", () => {
  const cases: [string, string | null][] = [
    ["owner/repo", "owner/repo"],
    ["  codemonkeyricky/insight  ", "codemonkeyricky/insight"],
    ["Owner/Repo", "owner/repo"],
    ["https://github.com/codemonkeyricky/insight", "codemonkeyricky/insight"],
    ["https://github.com/codemonkeyricky/insight.git", "codemonkeyricky/insight"],
    ["https://github.com/codemonkeyricky/insight/", "codemonkeyricky/insight"],
    ["http://www.github.com/o/r?tab=readme#top", "o/r"],
    ["github.com/my-org/socket.io", "my-org/socket.io"],
    ["", null],
    ["   ", null],
    ["owner", null],
    ["owner/repo/extra", null],
    ["https://github.com/o/r/tree/main", null],
    ["https://gitlab.com/o/r", null],
    ["-owner/repo", null],
    ["owner-/repo", null],
    ["owner/..", null],
    ["owner/.", null],
    ["owner/repo with space", null],
    ["o/r;rm", null],
  ];
  for (const [input, expected] of cases) {
    it(`reads ${JSON.stringify(input)} as ${expected ?? "an error"}`, () => {
      const parsed = parseRepoInput(input);
      if (expected === null) {
        expect(parsed.ok).toBe(false);
      } else {
        expect(parsed).toEqual({ ok: true, owner: expected.split("/")[0], repo: expected.split("/")[1] });
      }
    });
  }

  it("names a branch link as a link problem", () => {
    const parsed = parseRepoInput("https://github.com/o/r/tree/main");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/branch or folder/);
  });

  it("checks owner and repo names on their own", () => {
    expect(isRepoName("codemonkeyricky", "insight")).toBe(true);
    expect(isRepoName("a".repeat(40), "r")).toBe(false);
    expect(isRepoName("o", "r".repeat(101))).toBe(false);
  });

  it("builds the hash link with and without a sha", () => {
    expect(hrefHosted("o", "r")).toBe("#/gh/o/r");
    expect(hrefHosted("o", "r", "a".repeat(40))).toBe(`#/gh/o/r@${"a".repeat(40)}`);
  });
});

describe("index failures", () => {
  it("says what each code means for the repository", () => {
    expect(indexErrorText("not_found", "o/r")).toMatch(/No public GitHub repository named o\/r/);
    expect(indexErrorText("too_large", "o/r")).toMatch(/too large/);
    expect(indexErrorText("rate_limited", "o/r")).toMatch(/Too many/);
    expect(indexErrorText("timeout", "o/r")).toMatch(/time limit/);
    expect(indexErrorText("something_new", "o/r", "Server said so.")).toBe("Server said so.");
    expect(indexErrorText("something_new", "o/r")).toBe("Indexing o/r failed on the server.");
  });

  it("offers a retry only for transient failures", () => {
    expect(canRetry("rate_limited")).toBe(true);
    expect(canRetry("network")).toBe(true);
    expect(canRetry("too_large")).toBe(false);
    expect(canRetry("not_found")).toBe(false);
    expect(canRetry("index_failed")).toBe(false);
  });
});

describe("relative time", () => {
  const now = Date.parse("2026-11-11T12:00:00Z");
  it("phrases a past time in the largest whole unit", () => {
    expect(relativeTime("2026-11-11T11:58:30Z", now)).toBe("1 minute ago");
    expect(relativeTime("2026-11-11T09:00:00Z", now)).toBe("3 hours ago");
    expect(relativeTime("2026-11-08T12:00:00Z", now)).toBe("3 days ago");
    expect(relativeTime("2026-11-10T12:00:00Z", now)).toBe("yesterday");
  });
  it("is blank for a time it cannot read, and just now for a moment ago", () => {
    expect(relativeTime("not a date", now)).toBe("");
    expect(relativeTime("2026-11-11T11:59:30Z", now)).toBe("just now");
  });
});
