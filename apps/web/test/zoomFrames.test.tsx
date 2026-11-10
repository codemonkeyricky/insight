import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FrameShape } from "../src/components/zoom/ZoomMap";
import type { MapNode } from "../src/zoom/source";
import type { PlacedItem } from "@insight/flow";

// The runtime frames of the roots-only map: a thread box and the group that holds the functions no thread runs. The map
// itself builds its items in an effect, so the frame layer is rendered on its own, to static markup.

const frame = (id: string, x: number, y: number, w: number, h: number): PlacedItem => ({
  id,
  kind: "frame",
  rect: { x, y, w, h },
  inner: { x: x + 16, y: y + 30, w: w - 32, h: h - 46 },
  depth: 1,
});

const node = (id: string, kind: string, label: string, extra: Partial<MapNode> = {}): MapNode =>
  ({ id, kind, label, title: label, ...extra }) as MapNode;

const svg = (el: React.ReactElement) => renderToStaticMarkup(<svg>{el}</svg>);

describe("ZoomMap runtime frames", () => {
  it("draws a thread frame with its label, its thread class and a header the reader can click", () => {
    const html = svg(
      <FrameShape item={frame("thread:main", 0, 0, 360, 200)} node={node("thread:main", "thread", "Main thread", { detail: "3 functions" })} line="thread" k={1} onOpen={() => undefined} />,
    );
    expect(html).toContain("zm-frame zm-thread");
    expect(html).toContain("zm-line-thread");
    expect(html).toContain("Main thread");
    expect(html).toContain("zm-frame-body");
    expect(html).toContain("zm-hit");
  });

  it("draws the Not on a thread group as a frame of its own kind", () => {
    const html = svg(
      <FrameShape item={frame("unthreaded", 0, 300, 600, 120)} node={node("unthreaded", "group", "Not on a thread")} line="none" k={1} onOpen={() => undefined} />,
    );
    expect(html).toContain("zm-frame zm-group");
    expect(html).toContain("Not on a thread");
    expect(html).toContain("zm-line-none");
  });

  it("draws a process frame with the process class", () => {
    const html = svg(
      <FrameShape item={frame("prog:main", 0, 0, 800, 400)} node={node("prog:main", "program", "Process · main")} line="process" k={1} onOpen={() => undefined} />,
    );
    expect(html).toContain("zm-frame zm-program");
    expect(html).toContain("zm-line-process");
    expect(html).toContain("Process · main");
  });
});
