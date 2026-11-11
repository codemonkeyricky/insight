import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BoxShape, FrameShape } from "../src/components/zoom/ZoomMap";
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

const box = (id: string, x: number, y: number, w: number, h: number): PlacedItem => ({ id, kind: "box", rect: { x, y, w, h }, depth: 1 });

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

  it("draws an external command as a muted leaf: no function glyph, its name and a caption", () => {
    const html = svg(
      <BoxShape item={box("thread:spawn:1", 0, 0, 300, 60)} node={node("thread:spawn:1", "thread", "git", { external: true, detail: "0 functions" })} line="thread" k={1} onOpen={() => undefined} chartOpen={false} card />,
    );
    expect(html).toContain("zm-external");
    expect(html).toContain("zm-thread");
    expect(html).toContain(">git<");
    expect(html).toContain("external command");
    expect(html).not.toContain("ƒ");
    expect(html).not.toContain("zm-card");
  });

  it("does not open anything when an external command is clicked", () => {
    const clicks: string[] = [];
    const el = BoxShape({
      item: box("thread:spawn:1", 0, 0, 300, 60),
      node: node("thread:spawn:1", "thread", "git", { external: true }),
      line: "thread",
      k: 1,
      onOpen: (id) => clicks.push(id),
      chartOpen: false,
      card: true,
    }) as React.ReactElement<{ onClick?: () => void }>;
    el.props.onClick?.();
    expect(clicks).toEqual([]);
  });

  it("still opens a function card on click", () => {
    const clicks: string[] = [];
    const el = BoxShape({
      item: box("thread:main>a#run", 0, 0, 300, 60),
      node: node("thread:main>a#run", "function", "run", { ref: "a#run" }),
      line: "thread",
      k: 1,
      onOpen: (id) => clicks.push(id),
      chartOpen: false,
      card: true,
    }) as React.ReactElement<{ onClick?: () => void }>;
    el.props.onClick?.();
    expect(clicks).toEqual(["thread:main>a#run"]);
  });
});
