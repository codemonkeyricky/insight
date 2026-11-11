import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Project, RunProgress, SnapshotSummary } from "../src/api";
import { IndexProgress } from "../src/components/IndexProgress";
import { FirstIndex, IndexStrip, relativeAgo } from "../src/components/IndexStrip";
import { initialIndexState } from "../src/indexProgress";

const T0 = "2026-11-10T10:00:00.000Z";
const start = Date.parse(T0);
const run = (over: Partial<RunProgress>): RunProgress => ({ phase: "scan", label: "Scanning files", startedAt: T0, phaseStartedAt: T0, full: false, ...over });

describe("IndexProgress", () => {
  it("renders a counted extract with the elapsed time, a rough time left and the bar's value", () => {
    const html = renderToStaticMarkup(
      <IndexProgress
        progress={run({ phase: "extract", label: "Extracting · typescript", frontend: "typescript", step: 1, steps: 1, done: 312, total: 491, previousMs: 60000 })}
        now={start + 21000}
      />,
    );
    // 0.10 + 0.70 * 312 / 491 = 0.5448 of the bar, and 60 s * (1 - 0.5448) left.
    expect(html).toContain("Extracting · typescript 312 / 491 · 0:21 · ~0:27 left");
    expect(html).toContain('aria-valuenow="54"');
    expect(html).not.toContain("is-uncounted");
  });

  it("gives no time left before 15 % or without a previous run", () => {
    const early = renderToStaticMarkup(
      <IndexProgress progress={run({ phase: "extract", label: "Extracting · typescript", steps: 1, step: 1, done: 10, total: 491, previousMs: 60000 })} now={start + 4000} />,
    );
    expect(early).not.toContain("left");
    const first = renderToStaticMarkup(
      <IndexProgress progress={run({ phase: "extract", label: "Extracting · typescript", done: 400, total: 491 })} now={start + 4000} />,
    );
    expect(first).not.toContain("left");
  });

  it("shows a shimmer and no count for a phase that does not count its work", () => {
    const html = renderToStaticMarkup(<IndexProgress progress={run({ phase: "link", label: "Linking" })} now={start + 5000} />);
    expect(html).toContain("is-uncounted");
    expect(html).toContain("Linking · 0:05");
  });

  it("shows a failed run in red with its error", () => {
    const html = renderToStaticMarkup(<IndexProgress error="Indexing failed: boom" fraction={0.4} />);
    expect(html).toContain("is-failed");
    expect(html).toContain('class="idx-label small error"');
    expect(html).toContain("Indexing failed: boom");
    expect(html).not.toContain("is-uncounted");
  });

  it("shows a settled summary without a shimmer", () => {
    const html = renderToStaticMarkup(<IndexProgress fraction={1} label="Indexed · 23,378 nodes" />);
    expect(html).toContain("Indexed · 23,378 nodes");
    expect(html).toContain('aria-valuenow="100"');
    expect(html).not.toContain("is-uncounted");
  });

  it("turns the shimmer off under reduced motion, in the stylesheet", () => {
    const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce) {", css.indexOf(".idx-fill")));
    expect(block).toMatch(/\.idx-bar\.is-uncounted::after \{ animation: none;/);
  });
});

describe("relativeAgo", () => {
  it("reads minutes, hours and days", () => {
    const now = start + 3 * 3600_000;
    expect(relativeAgo(T0, start + 20_000)).toBe("just now");
    expect(relativeAgo(T0, start + 12 * 60_000)).toBe("12 min ago");
    expect(relativeAgo(T0, now)).toBe("3 h ago");
    expect(relativeAgo(T0, start + 49 * 3600_000)).toBe("2 d ago");
  });
});

describe("IndexStrip", () => {
  const project = { id: "p", name: "Insight", status: "idle", queued: false } as unknown as Project;
  const snapshot: SnapshotSummary = { id: "s", createdAt: T0, commit: "abcdef1234567", nodes: 23378, edges: 1, findings: 0 };
  const noop = () => {};

  it("at rest shows the Index button, the last index and its commit", () => {
    const html = renderToStaticMarkup(<IndexStrip id="p" project={project} snapshot={snapshot} run={initialIndexState} onRequested={noop} />);
    expect(html).toMatch(/<button[^>]*>Index<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled/);
    expect(html).toContain("Indexed ");
    expect(html).toContain("abcdef1");
  });

  it("while running disables the button and offers the Log link", () => {
    const html = renderToStaticMarkup(
      <IndexStrip
        id="p"
        project={{ ...project, status: "indexing" } as Project}
        snapshot={snapshot}
        run={{ ...initialIndexState, running: true, progress: run({ phase: "link", label: "Linking" }), fraction: 0.8 }}
        onRequested={noop}
      />,
    );
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Indexing<\/button>/);
    expect(html).toContain("Log</a>");
    expect(html).toContain("idx-strip");
  });

  it("after a failed run shows the error with Retry", () => {
    const html = renderToStaticMarkup(
      <IndexStrip id="p" project={project} snapshot={snapshot} run={{ ...initialIndexState, lastError: "boom" }} onRequested={noop} />,
    );
    expect(html).toContain("Indexing failed: boom");
    expect(html).toContain(">Retry</button>");
  });
});

describe("IndexStrip polish", () => {
  it("the done summary is normal text, not the muted rest colour", () => {
    const html = renderToStaticMarkup(<IndexProgress fraction={1} label="Indexed · 23,502 nodes" />);
    expect(html).toContain('class="idx-label small"');
    expect(html).not.toContain("muted");
  });

  it("the Overview has no Re-index row or progress bar of its own, and the header badge is off that page", () => {
    const overview = readFileSync(new URL("../src/pages/ProjectOverview.tsx", import.meta.url), "utf8");
    expect(overview).not.toContain("Re-index");
    expect(overview).not.toContain("components/IndexProgress");
    expect(overview).not.toMatch(/<IndexProgress\b/);
    expect(overview).toContain("Run log");
    const workspace = readFileSync(new URL("../src/components/Workspace.tsx", import.meta.url), "utf8");
    expect(workspace).toContain('content !== "overview" && <StatusBadge');
  });
});

describe("FirstIndex", () => {
  it("names the project while its first run is under way", () => {
    const html = renderToStaticMarkup(
      <FirstIndex name="Insight" running run={{ ...initialIndexState, running: true, progress: run({ phase: "scan", label: "Scanning files" }), fraction: 0.05 }} />,
    );
    expect(html).toContain("Indexing Insight…");
    expect(html).toContain("idx-first");
  });
});
