import { describe, expect, it } from "vitest";
import type { IREdge, IRNode } from "@insight/ir";
import { couplingFacts, type Item } from "../src/index.js";

// A channel send whose argument is a call: the call is drawn as its own row, before the send's row.

const FILE = "src/send.ts";
const PROVENANCE = { frontend: "test", confidence: "exact" as const };
const PUBLISH = `${FILE}#publish`;

const publishFn = (): IRNode =>
  ({
    id: PUBLISH,
    facet: "structure",
    kind: "structure.function",
    span: { file: FILE, start: [10, 0], end: [20, 1] },
    attrs: { name: "publish", qualifiedName: "publish" },
    provenance: PROVENANCE,
  }) as IRNode;

// `ch.postMessage(serialize(state))` on line 12: the send spans the line, the call only its callee name.
const sendNode = (): IRNode =>
  ({
    id: "send:12",
    parent: PUBLISH,
    facet: "concurrency",
    kind: "concurrency.channel-send",
    span: { file: FILE, start: [12, 2], end: [12, 40] },
    attrs: { channel: "jobs" },
    provenance: PROVENANCE,
  }) as IRNode;

const serializeCall = (): IREdge =>
  ({
    from: PUBLISH,
    to: `${FILE}#serialize`,
    facet: "calls",
    kind: "calls.call",
    span: { file: FILE, start: [12, 15], end: [12, 24] },
    attrs: { callee: "serialize" },
    provenance: PROVENANCE,
  }) as IREdge;

const labelOf = (i: Item): string => (i.t === "step" ? i.label : i.t);

describe("sync operations keep the calls inside their arguments", () => {
  it("draws the argument's call row before the send row", () => {
    const facts = couplingFacts([publishFn(), sendNode()], [serializeCall()]).facts.get(PUBLISH);
    const labels = (facts?.items ?? []).map(labelOf);
    expect(labels).toHaveLength(2);
    const callAt = labels.findIndex((l) => l.includes("serialize"));
    const sendAt = labels.findIndex((l) => l.includes("jobs"));
    expect(callAt).toBeGreaterThanOrEqual(0);
    expect(sendAt).toBeGreaterThan(callAt);
  });
});
