import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReindexView, indexedLine, type ReindexState } from "../src/components/HostedReindex";
import { IndexRequestError, refPointerUrl, readRefPointer, requestIndex } from "../src/hostedApi";
import { hrefHosted, indexErrorText, rateLimitText, waitText } from "../src/hostedRepo";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const NOW = Date.parse("2026-11-11T12:00:00Z");

function view(state: ReindexState, over: Partial<Parameters<typeof ReindexView>[0]> = {}): string {
  return renderToStaticMarkup(
    <ReindexView sha={SHA} from="main" indexedAt="2026-11-08T12:00:00Z" now={NOW} branch="main" state={state} onBranch={() => undefined} onSubmit={() => undefined} {...over} />,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("the re-index control", () => {
  it("rests on the branch field, the button and the 'Indexed <sha7> from <ref> · <age>' line", () => {
    const html = view({ kind: "idle" });
    expect(html).toContain('value="main"');
    expect(html).toContain("Re-index latest");
    expect(html).toContain("Indexed 0123456 from main · 3 days ago");
    expect(html).not.toContain("disabled");
  });

  it("says Already up to date with the short sha", () => {
    expect(view({ kind: "uptodate", sha: SHA })).toContain("Already up to date · 0123456");
  });

  it("shows the phase and a bar while running, and disables the field and the button", () => {
    const html = view({ kind: "running", status: { state: "running", phase: "analyze", done: 1, total: 4 } });
    expect(html).toContain("Analyzing the code");
    expect(html).toContain('aria-valuenow="25"');
    expect(html).toContain("Indexing</button>");
    expect(html.match(/disabled/g)?.length).toBe(2);
  });

  it("shows an error, such as the rate limit, as an alert", () => {
    const html = view({ kind: "error", message: rateLimitText("the daily indexing limit has been reached", 5400) });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Resets in about 2 h");
  });

  it("leaves the field empty with a placeholder when the ref is unknown, and drops 'from'", () => {
    const html = view({ kind: "idle" }, { branch: "", from: undefined });
    expect(html).toContain('placeholder="default branch"');
    expect(html).toContain("Indexed 0123456 · 3 days ago");
  });

  it("disables the button for a branch name the server would refuse", () => {
    expect(view({ kind: "idle" }, { branch: "a b" })).toContain("disabled");
  });

  it("words the line without a time when the age is unknown", () => {
    expect(indexedLine(SHA, "dev", undefined, NOW)).toBe("Indexed 0123456 from dev");
  });
});

describe("branch helpers", () => {
  it("writes branch links with the slash encoded, and sha links as before", () => {
    expect(hrefHosted("o", "r", undefined, "build/insight-plan")).toBe("#/gh/o/r@build%2Finsight-plan");
    expect(hrefHosted("o", "r", SHA)).toBe(`#/gh/o/r@${SHA}`);
    expect(hrefHosted("o", "r")).toBe("#/gh/o/r");
  });

  it("asks the Worker for a pointer with the key's % escaped once more", () => {
    expect(refPointerUrl("https://s.test/", "o", "r", "main")).toBe("https://s.test/gh/o/r/refs/main.json");
    expect(refPointerUrl("https://s.test/", "o", "r", "build/x")).toBe("https://s.test/gh/o/r/refs/build%252Fx.json");
    expect(refPointerUrl("https://s.test/", "o", "r", "@default")).toBe("https://s.test/gh/o/r/refs/%40default.json");
  });

  it("reads a pointer, and answers undefined for a branch with none", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith("refs/main.json") ? new Response(JSON.stringify({ ref: "main", sha: SHA, indexedAt: "t" })) : new Response("", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await readRefPointer("/storage/", "o", "r", "main")).toEqual({ ref: "main", sha: SHA, indexedAt: "t" });
    expect(await readRefPointer("/storage/", "o", "r", "nope")).toBeUndefined();
  });

  it("carries the wait of a 429 on the request error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "rate_limited", message: "limit", retryAfterSeconds: 600 } }), { status: 429 })));
    const err = await requestIndex("o/r", "main").catch((e) => e);
    expect(err).toBeInstanceOf(IndexRequestError);
    expect(err.retryAfterSeconds).toBe(600);
    expect(rateLimitText("limit", err.retryAfterSeconds)).toBe("limit. Resets in about 10 min.");
    expect(waitText(30)).toBe("30 s");
  });

  it("says Branch not found for a missing ref, and the repo message otherwise", () => {
    expect(indexErrorText("not_found", "o/r", "ref nope was not found in o/r", "nope")).toContain("Branch not found on GitHub");
    expect(indexErrorText("not_found", "o/r", "o/r was not found on GitHub", "nope")).toContain("No public GitHub repository");
  });
});
