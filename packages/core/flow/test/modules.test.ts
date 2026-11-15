import { describe, expect, it } from "vitest";
import * as fx from "@insight/sdk/testing";
import { moduleMap, packageRoots, rootOf } from "../src/index.js";

const sp = (file: string) => fx.span(file, 0, 0, 0, 20);
const file = (path: string) => fx.node(path, "structure", "structure.file");
const pkg = (dir: string) => file(`${dir}/package.json`);

describe("packageRoots", () => {
  it("takes package.json directories as roots, and skips fixture and node_modules folders", () => {
    const roots = packageRoots([
      pkg("packages/a"),
      pkg("packages/b"),
      pkg("samples/demo"),
      pkg("packages/a/node_modules/dep"),
      file("packages/a/src/x.ts"),
    ]);
    expect(roots.map((r) => r.path).sort()).toEqual(["packages/a", "packages/b"]);
    expect(roots.find((r) => r.path === "packages/a")?.name).toBe("a");
  });

  it("takes names and paths from structure.package nodes, the first source", () => {
    const roots = packageRoots([
      fx.node("pkg:core", "structure", "structure.package", { attrs: { root: "packages/core", name: "core-lib" } }),
      pkg("packages/core"),
    ]);
    expect(roots).toEqual([{ path: "packages/core", name: "core-lib" }]);
  });
});

describe("moduleMap", () => {
  it("assigns each file to its nearest package root", () => {
    const map = moduleMap([pkg("packages/a"), pkg("packages/a/sub"), file("packages/a/src/x.ts"), file("packages/a/sub/y.ts")]);
    expect(map.generic).toBe(false);
    expect(map.moduleOfFile("packages/a/src/x.ts")).toBe("packages/a");
    expect(map.moduleOfFile("packages/a/sub/y.ts")).toBe("packages/a/sub");
    expect(map.moduleOfFile("tools/z.ts")).toBe(".");
  });

  it("uses the top-level folder when the only root is '.' (no package metadata)", () => {
    const map = moduleMap([pkg("."), file("src/a.ts"), file("lib/b.ts"), file("root.ts")]);
    expect(map.generic).toBe(true);
    expect(map.moduleOfFile("src/a.ts")).toBe("src");
    expect(map.moduleOfFile("lib/b.ts")).toBe("lib");
    expect(map.moduleOfFile("root.ts")).toBe(".");
  });

  it("is generic when there are no roots at all", () => {
    const map = moduleMap([file("src/a.ts")]);
    expect(map.generic).toBe(true);
    expect(map.roots).toEqual([]);
    expect(map.moduleOfFile("src/a.ts")).toBe("src");
  });

  it("moduleOf takes a structure.module ancestor when there is one", () => {
    const map = moduleMap([
      fx.node("mod:rtl", "structure", "structure.module"),
      fx.node("rtl/a.sv#f", "structure", "structure.function", { parent: "mod:rtl", span: sp("rtl/a.sv") }),
    ]);
    expect(map.moduleOf("rtl/a.sv#f")).toBe("mod:rtl");
  });

  it("moduleOf falls back to the node's file, then to the part of the id before '#'", () => {
    const map = moduleMap([pkg("packages/a"), fx.node("packages/a/src/x.ts#f", "structure", "structure.function", { span: sp("packages/a/src/x.ts") })]);
    expect(map.moduleOf("packages/a/src/x.ts#f")).toBe("packages/a");
    expect(map.moduleOf("packages/a/src/y.ts#g")).toBe("packages/a");
  });

  it("rootOf ranks the deepest matching root and never picks a sibling prefix", () => {
    const roots = packageRoots([pkg("packages/a"), pkg("packages/ab"), pkg("packages/a/nested")]);
    expect(rootOf(roots, "packages/a/nested/x.ts")?.path).toBe("packages/a/nested");
    expect(rootOf(roots, "packages/ab/x.ts")?.path).toBe("packages/ab");
    expect(rootOf(roots, "other/x.ts")).toBeUndefined();
  });
});
