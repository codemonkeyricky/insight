import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BoxShape, isMoreCard } from "../src/components/zoom/ZoomMap";
import type { MapNode } from "../src/zoom/source";
import { cardWidth, type PlacedItem } from "@insight/flow";

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
    expect(html).toContain("<title>main · Shares lock a between threads it reaches</title>");
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
    expect(html).toContain("Shares lock a, channel q between threads it reaches");
  });

  it("draws no self-sync badge on a card without one", () => {
    const html = svg(
      <BoxShape item={box("main", 0, 0, 300, 60)} node={node("main", "function", "main", { ref: "src/m.ts#main" })} line="thread" k={1} onOpen={() => undefined} chartOpen={false} card />,
    );
    expect(html).not.toContain("zm-sync-self");
    expect(html).not.toContain("threads it reaches");
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

describe("the flat grid's card names", () => {
  const card = (n: MapNode) => (
    <BoxShape item={box(n.id, 0, 0, 240, 56)} node={n} line="thread" k={1} onOpen={() => undefined} chartOpen={false} card />
  );

  it("draws a same-name card's name alone, with its file stem on a second line", () => {
    const html = svg(card(node("main", "function", "main", { ref: "apps/web/main.tsx#(module)", shownName: "main · web" })));
    expect(html).toContain('class="zm-card-sub"');
    expect(html).toContain(">web</text>");
    expect(html).toContain("ƒ</tspan> main</text>");
    expect(html).not.toContain("main · web</text>");
  });

  it("draws no stem line on a card whose name is unique", () => {
    const html = svg(card(node("solo", "function", "solo", { ref: "src/solo.ts#solo" })));
    expect(html).not.toContain("zm-card-sub");
  });

  it("opens the more card by its kind, not its id: a function named more is not one", () => {
    expect(isMoreCard({ kind: "more" })).toBe(true);
    expect(isMoreCard({ kind: "function" })).toBe(false);
    expect(isMoreCard(undefined)).toBe(false);
  });
});

describe("the flat grid's card fits", () => {
  // A card drawn at the width cardWidth gives its name, at 1x, with its Callers button: the whole name shows, no "…".
  it.each([["a"], ["settle"], ["settleChains"], ["bodyCountOfTheActuatorChain"], ["linkPlateLongNameHere"]])("shows the whole name %s at 1x", (name) => {
    const html = svg(
      <BoxShape
        item={box("fn", 0, 0, cardWidth(name), 56)}
        node={node("fn", "function", name, { ref: `src/x.ts#${name}` })}
        line="thread"
        k={1}
        onOpen={() => undefined}
        onCallers={() => undefined}
        chartOpen={false}
        card
      />,
    );
    expect(html).toContain(`ƒ</tspan> ${name}</text>`);
    expect(html).toContain("zm-callers-btn");
    expect(html).not.toContain("…");
  });

  it("shows a more card's whole name at its own width, with no Callers button", () => {
    const name = "+12 more";
    const html = svg(
      <BoxShape item={box("p#more", 0, 0, cardWidth(name, false), 56)} node={node("p#more", "more", name)} line="thread" k={1} onOpen={() => undefined} chartOpen={false} card />,
    );
    expect(html).toContain(`ƒ</tspan> ${name}</text>`);
    expect(html).not.toContain("…");
  });

  it("keeps the stem line clear of the self-sync badge: a stem under the badge is cut short", () => {
    // At 320 wide the stem's room is 38 characters plain and 33 under the badge, so a 36-character stem fits plain only.
    const stem = "abcdefghijklmnopqrstuvwxyz0123456789";
    const draw = (syncSelf?: MapNode["syncSelf"]) =>
      svg(
        <BoxShape
          item={box("main", 0, 0, 320, 56)}
          node={node("main", "function", "main", { ref: "src/m.ts#main", shownName: `main · ${stem}`, syncSelf })}
          line="thread"
          k={1}
          onOpen={() => undefined}
          chartOpen={false}
          card
        />,
      );
    const subOf = (html: string) => /class="zm-card-sub"[^>]*>([^<]*)</.exec(html)?.[1] ?? "";
    const plain = subOf(draw());
    const badged = subOf(draw([{ name: "a", kind: "lock" }]));
    expect(plain).toBe(stem);
    expect(badged.length).toBeLessThan(plain.length);
    expect(badged.endsWith("…")).toBe(true);
  });

  it("opens a function card whose id ends in #more, and does not treat it as the more card", () => {
    const clicks: string[] = [];
    const el = BoxShape({
      item: box("pkg/mod.ts#more", 0, 0, 240, 56),
      node: node("pkg/mod.ts#more", "function", "more", { ref: "pkg/mod.ts#more" }),
      line: "thread",
      k: 1,
      onOpen: (id) => clicks.push(id),
      chartOpen: false,
      card: true,
    }) as React.ReactElement<{ onClick?: () => void }>;
    el.props.onClick?.();
    expect(clicks).toEqual(["pkg/mod.ts#more"]);
    expect(isMoreCard({ kind: "function" })).toBe(false);
  });
});
