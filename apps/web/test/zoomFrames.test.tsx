import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BoxShape } from "../src/components/zoom/ZoomMap";
import type { MapNode } from "../src/zoom/source";
import type { PlacedItem } from "@insight/flow";

// The boxes of the flat grid: a card, an external command's chip, and a card's badges. The Flow canvas draws no runtime frames
// (thread, group, process), so none is tested here. The map builds its items in an effect, so a box is rendered on its own,
// to static markup, or its click handler is called directly.

const node = (id: string, kind: string, label: string, extra: Partial<MapNode> = {}): MapNode =>
  ({ id, kind, label, title: label, ...extra }) as MapNode;

const box = (id: string, x: number, y: number, w: number, h: number): PlacedItem => ({ id, kind: "box", rect: { x, y, w, h }, depth: 1 });

const svg = (el: React.ReactElement) => renderToStaticMarkup(<svg>{el}</svg>);

describe("ZoomMap boxes", () => {
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

  it("draws a card's self-sync badge with its count, and a tooltip naming the resource", () => {
    const html = svg(
      <BoxShape
        item={box("main", 0, 0, 300, 60)}
        node={node("main", "function", "main", { ref: "src/m.ts#main", syncSelf: [{ name: "a", kind: "lock" }] })}
        line="thread"
        k={1}
        onOpen={() => undefined}
        chartOpen={false}
        card
      />,
    );
    expect(html).toContain("zm-sync-self");
    expect(html).toContain("⇆ 1</text>");
    expect(html).toContain("<title>main · Shares lock a with threads it starts</title>");
  });

  it("counts every self-sync resource and lists each by kind and name in the tooltip", () => {
    const html = svg(
      <BoxShape
        item={box("main", 0, 0, 300, 60)}
        node={node("main", "function", "main", { ref: "src/m.ts#main", syncSelf: [{ name: "a", kind: "lock" }, { name: "q", kind: "channel" }] })}
        line="thread"
        k={1}
        onOpen={() => undefined}
        chartOpen={false}
        card
      />,
    );
    expect(html).toContain("⇆ 2</text>");
    expect(html).toContain("Shares lock a, channel q with threads it starts");
  });

  it("draws no self-sync badge on a card without one", () => {
    const html = svg(
      <BoxShape item={box("main", 0, 0, 300, 60)} node={node("main", "function", "main", { ref: "src/m.ts#main" })} line="thread" k={1} onOpen={() => undefined} chartOpen={false} card />,
    );
    expect(html).not.toContain("zm-sync-self");
    expect(html).not.toContain("threads it starts");
  });

  it("N2: a card carrying a thread's unguarded names draws the warning badge and its tooltip", () => {
    const html = svg(
      <BoxShape
        item={box("main", 0, 0, 300, 60)}
        node={node("main", "function", "main", { ref: "src/m.ts#main", unguarded: ["counter"] })}
        line="thread"
        k={1}
        onOpen={() => undefined}
        chartOpen={false}
        card
      />,
    );
    expect(html).toContain("zm-unguarded");
    expect(html).toContain("zm-warn");
    expect(html).toContain("unguarded shared state: counter");
    expect(html).not.toContain("zm-sync-self");
  });
});
