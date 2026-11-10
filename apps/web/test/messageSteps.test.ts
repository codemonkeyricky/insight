import { describe, expect, it } from "vitest";
import type { FlowNode, FunctionFlow } from "@insight/flow";
import { buildProjectModel, refsOf, scopeView } from "@insight/model";
import { isPostStep, messageReceivers, withMessageTargets } from "../src/flowTargets";

// A page posts to a worker (`send`, two receivers, and `idle`, which posts nothing); the worker answers the page (`reply`).
// The receivers are the handlers the worker file installs and the page's `onPageMsg`. The model is built from IR the way
// the page builds it, so the lists under test are the ones the Flow panel reads.

type Doc = Parameters<typeof buildProjectModel>[0];
const P = { frontend: "test", confidence: "exact" as const };
const PAGE = "src/page.ts";
const WORKER = "src/worker.ts";

const fileNode = (path: string) => ({ id: path, facet: "structure", kind: "structure.file", attrs: { path }, provenance: P });
const fnNode = (file: string, name: string, line: number) => ({
  id: `${file}#${name}`,
  facet: "structure",
  kind: "structure.function",
  parent: file,
  span: { file, start: [line, 0] as [number, number], end: [line + 3, 1] as [number, number] },
  attrs: { name },
  provenance: P,
});
const at = (file: string, line: number) => ({ file, start: [line, 2] as [number, number], end: [line, 9] as [number, number] });
const message = (from: string, to: string, file: string, line: number) => ({
  from,
  to,
  facet: "concurrency",
  kind: "concurrency.dispatches",
  attrs: { how: "message" },
  span: at(file, line),
  provenance: P,
});

const doc: Doc = {
  nodes: [
    fileNode(PAGE),
    fileNode(WORKER),
    fnNode(PAGE, "send", 0),
    fnNode(PAGE, "idle", 4),
    fnNode(PAGE, "onPageMsg", 8),
    fnNode(WORKER, "onWorkerMsg", 0),
    fnNode(WORKER, "onOther", 4),
    fnNode(WORKER, "reply", 8),
  ] as Doc["nodes"],
  edges: [
    message(`${PAGE}#send`, `${WORKER}#onWorkerMsg`, PAGE, 1),
    message(`${PAGE}#send`, `${WORKER}#onOther`, PAGE, 2),
    message(`${WORKER}#reply`, `${PAGE}#onPageMsg`, WORKER, 9),
  ] as Doc["edges"],
  findings: [],
} as Doc;

const model = buildProjectModel(doc);
const receiversOf = (fnId: string) => messageReceivers(refsOf(scopeView(model, ""), fnId).calls);

/** A chart of one function, holding the given steps. Only the nodes matter here. */
const chartOf = (id: string, nodes: FlowNode[]): FunctionFlow => ({ id, name: id, nodes, edges: [] }) as unknown as FunctionFlow;
const postStep = (id: string, line: number): FlowNode =>
  ({ id, role: "effect", shape: "step", label: "message.post · postMessage", title: "message.post · postMessage", span: at(PAGE, line), x: 0, y: 0, w: 120, h: 30 }) as FlowNode;

describe("message steps resolve their receiver from the model", () => {
  it("points a message.post step at the receiver of its message edge", () => {
    const chart = chartOf(`${WORKER}#reply`, [postStep("p", 9)]);
    const out = withMessageTargets(chart, receiversOf(`${WORKER}#reply`));
    const node = out.nodes[0];
    expect(node).toMatchObject({ target: `${PAGE}#onPageMsg`, handler: true, label: "post ▸ onPageMsg" });
    expect(node?.title).toBe("message.post to onPageMsg");
  });

  it("opens the first receiver by id, and the tooltip lists every receiver", () => {
    const chart = chartOf(`${PAGE}#send`, [postStep("p", 1)]);
    const out = withMessageTargets(chart, receiversOf(`${PAGE}#send`));
    expect(receiversOf(`${PAGE}#send`).map((r) => r.id)).toEqual([`${WORKER}#onOther`, `${WORKER}#onWorkerMsg`]);
    expect(out.nodes[0]).toMatchObject({ target: `${WORKER}#onOther`, label: "post ▸ onOther +1" });
    expect(out.nodes[0]?.title).toBe("message.post to onOther, onWorkerMsg");
  });

  it("gives no target when the function has no message edge", () => {
    expect(receiversOf(`${PAGE}#idle`)).toEqual([]);
    const chart = chartOf(`${PAGE}#idle`, [postStep("p", 5)]);
    const out = withMessageTargets(chart, receiversOf(`${PAGE}#idle`));
    expect(out).toBe(chart);
    expect(out.nodes[0]?.target).toBeUndefined();
    expect(out.nodes[0]?.handler).toBeUndefined();
  });

  it("recognises the post step by its kind, and leaves other steps alone", () => {
    expect(isPostStep(postStep("p", 1))).toBe(true);
    const other = { ...postStep("q", 1), label: "call · fetch", title: undefined };
    expect(isPostStep(other)).toBe(false);
    const chart = chartOf(`${PAGE}#send`, [other]);
    expect(withMessageTargets(chart, receiversOf(`${PAGE}#send`))).toBe(chart);
  });
});
