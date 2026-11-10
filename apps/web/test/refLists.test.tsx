import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RefRow, Refs } from "@insight/model";
import { RefLists } from "../src/components/zoom/RefLists";
import { parseRoute } from "../src/router";

// The lists render to static markup. Each row is one anchor whose href is the route the row opens, so parsing the href
// shows where a click lands.

const row = (over: Partial<RefRow>): RefRow => ({
  id: "packages/core/src/a.ts#f",
  name: "f",
  file: "packages/core/src/a.ts",
  line: 3,
  isFunction: true,
  kind: "call",
  candidate: false,
  count: 1,
  inScope: true,
  ...over,
});

const refs: Refs = {
  calledBy: [
    row({ id: "packages/model/src/scope.ts#inScope", name: "inScope", file: "packages/model/src/scope.ts", line: 71 }),
    row({ id: "packages/core/test/scope.test.ts#caller", name: "caller", file: "packages/core/test/scope.test.ts", line: 9, inScope: false }),
  ],
  calls: [],
};

const html = renderToStaticMarkup(<RefLists id="p1" scope="packages/model" roots={false} refs={refs} />);

describe("reverse reference lists", () => {
  it("renders each function row as one link with the ref-row class", () => {
    const anchors = html.match(/<a class="ref-row"[^>]*>/g) ?? [];
    expect(anchors).toHaveLength(2);
  });

  it("an in-scope row keeps the scope and selects its function", () => {
    const href = html.match(/<a class="ref-row" href="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&");
    expect(href).toBeDefined();
    const route = parseRoute(href ?? "");
    expect(route).toMatchObject({ name: "workspace", tab: "flow", scope: "packages/model", fn: "packages/model/src/scope.ts#inScope" });
  });

  it("an outside row switches the scope to its file and selects its function", () => {
    const hrefs = [...html.matchAll(/<a class="ref-row" href="([^"]+)"/g)].map((m) => m[1]?.replace(/&amp;/g, "&") ?? "");
    const route = parseRoute(hrefs[1] ?? "");
    expect(route).toMatchObject({
      name: "workspace",
      tab: "flow",
      scope: "packages/core/test/scope.test.ts",
      fn: "packages/core/test/scope.test.ts#caller",
    });
  });
});

describe("reverse reference lists: message edges", () => {
  it("labels a dispatch row with how message as message", () => {
    const msg = renderToStaticMarkup(
      <RefLists id="p1" scope="packages/model" roots={false} refs={{ calledBy: [], calls: [row({ kind: "dispatch", how: "message", name: "onPageMsg" })] }} />,
    );
    expect(msg).toContain('<span class="kind dispatch">message</span>');
  });
});
