import { describe, expect, it } from "vitest";
import type { IREdge, IRNode } from "@insight/ir";
import { execModel } from "../src/index.js";
import { PROVENANCE } from "./synthetic.js";

/** A cc_binary build target: its name is the rule's name, its label the target's full label. */
function binary(label: string, name: string): IRNode {
  return { id: label, facet: "packaging", kind: "packaging.build-target", attrs: { name, label, targetKind: "cc_binary", source: "static" }, provenance: PROVENANCE };
}
const contains = (target: string, file: string): IREdge => ({ from: target, to: file, facet: "packaging", kind: "packaging.target-contains", provenance: PROVENANCE });

describe("program names", () => {
  it("names two same-named programs by their labels, and keeps a unique name", () => {
    const nodes: IRNode[] = [
      binary("//tools/a:main", "main"),
      binary("//tools/b:main", "main"),
      binary("//app:server", "server"),
    ];
    const edges: IREdge[] = [
      contains("//tools/a:main", "tools/a/main.cc"),
      contains("//tools/b:main", "tools/b/main.cc"),
      contains("//app:server", "app/server.cc"),
    ];
    const model = execModel(nodes, edges, "");
    expect(model.programs.map((p) => [p.id, p.name])).toEqual([
      ["//app:server", "server"],
      ["//tools/a:main", "//tools/a:main"],
      ["//tools/b:main", "//tools/b:main"],
    ]);
  });
});
