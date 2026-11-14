import { createRequire } from "node:module";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ElkNode } from "elkjs/lib/elk-api";
import { Legend, MachineSvg, arcName, type MachinePick } from "../src/components/StateDiagram";
import { MachineList, SiteList } from "../src/components/MachineSection";
import { ViewBlock } from "../src/pages/LensPage";
import { layoutMachine, type Solve } from "../src/states/layout";
import { machinesOf, readMachineParam, selectMachine, withMachineParam } from "../src/states/machineParam";
import type { TableView } from "../src/api";
import { hubConnectionMachine, twoStateMachine } from "./fixtures/hubConnectionMachine";

const require = createRequire(import.meta.url);
const ELK = require("elkjs/lib/elk.bundled.js");
const solve: Solve = (g: ElkNode) => new ELK().layout(g);

/** Every element in a tree (calling hook-free function components), matching `pred`. */
function findAll(node: ReactNode, pred: (el: ReactElement<Record<string, unknown>>) => boolean, out: ReactElement<Record<string, unknown>>[] = []) {
  if (Array.isArray(node)) node.forEach((n) => findAll(n, pred, out));
  else if (isValidElement(node)) {
    const el = node as ReactElement<Record<string, unknown>>;
    if (typeof el.type === "function") return findAll((el.type as (p: unknown) => ReactNode)(el.props), pred, out);
    if (pred(el)) out.push(el);
    findAll(el.props.children as ReactNode, pred, out);
  }
  return out;
}
const hasClass = (el: ReactElement<Record<string, unknown>>, c: string) => String(el.props.className ?? "").split(" ").includes(c);

describe("MachineSvg", async () => {
  const laid = await layoutMachine(hubConnectionMachine, solve);
  const tree = (onPick?: (p: MachinePick) => void) => <MachineSvg view={hubConnectionMachine} laid={laid} {...(onPick ? { onPick } : {})} />;
  const html = renderToStaticMarkup(tree());

  it("draws one rounded rect per state, a start dot and a label per arc", () => {
    const named = hubConnectionMachine.states.filter((s) => s.kind !== "initial");
    expect((html.match(/class="sm-box"/g) ?? []).length).toBe(named.length);
    expect(html).toContain('class="sm-start"');
    expect(html).toContain('rx="10"');
    const labelled = hubConnectionMachine.transitions.filter((t) => t.label).length;
    expect((html.match(/class="sm-label"/g) ?? []).length).toBe(labelled);
  });

  it("draws inferred arcs dashed (sm-arc--inferred), heuristic dotted, and a self-loop", () => {
    expect(html).toContain("sm-arc--inferred");
    expect(html).toContain("sm-arc--heuristic");
    const loop = laid.arcs.find((a) => a.selfLoop)!;
    expect(html).toContain(`d="${loop.d}"`);
    expect(findAll(tree(), (e) => hasClass(e, "sm-arc")).length).toBe(hubConnectionMachine.transitions.length);
  });

  it("marks the unentered state, and a state with no way out as final", async () => {
    expect(html).toContain("sm-state--unentered");
    expect(laid.states.every((s) => !s.terminal)).toBe(true);
    const small = await layoutMachine(twoStateMachine, solve);
    expect(small.states.filter((s) => s.terminal).map((s) => s.label)).toEqual(["busy"]);
    expect(renderToStaticMarkup(<MachineSvg view={twoStateMachine} laid={small} />)).toContain("sm-box--inner");
  });

  it("makes arcs and states focusable with a spoken name", () => {
    expect(html).toContain('aria-label="Disconnected to Connecting, start, inferred"');
    expect(html).toContain('tabindex="0"');
    const t = hubConnectionMachine.transitions[1]!;
    expect(arcName(hubConnectionMachine, t)).toBe("Disconnected to Connecting, start, inferred");
  });

  it("calls onPick with the first site span when an arc is clicked, or Enter pressed", () => {
    const onPick = vi.fn();
    const arcs = findAll(tree(onPick), (e) => hasClass(e, "sm-arc"));
    const t = hubConnectionMachine.transitions[4]!; // Connected -> Disconnected
    const idx = hubConnectionMachine.transitions.indexOf(t);
    (arcs[idx]!.props.onClick as () => void)();
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0]![0].span).toEqual(t.sites[0]!.span);
    expect(onPick.mock.calls[0]![0].transition).toBe(t);
    (arcs[idx]!.props.onKeyDown as (e: unknown) => void)({ key: "Enter", preventDefault() {} });
    expect(onPick).toHaveBeenCalledTimes(2);
  });

  it("calls onPick with the span of a state when it is clicked", () => {
    const onPick = vi.fn();
    const states = findAll(tree(onPick), (e) => hasClass(e, "sm-state"));
    const i = hubConnectionMachine.states.findIndex((s) => s.label === "Connecting");
    (states[i]!.props.onClick as () => void)();
    expect(onPick.mock.calls[0]![0]).toEqual({ span: hubConnectionMachine.states[i]!.span, label: "Connecting" });
  });

  it("hover reports the id so in and out arcs can be highlighted", () => {
    const hot = renderToStaticMarkup(<MachineSvg view={hubConnectionMachine} laid={laid} hot={hubConnectionMachine.states[2]!.id} />);
    expect(hot).toContain("sm-svg--hot");
    expect(hot).toContain("sm-arc--hot");
    expect(hot).toContain("sm-state--hot");
  });

  it("shows a legend for the kinds in use", () => {
    const l = renderToStaticMarkup(<Legend view={hubConnectionMachine} />);
    expect(l).toContain("inferred");
    expect(l).toContain("heuristic");
    expect(l).toContain("never entered");
    expect(renderToStaticMarkup(<Legend view={twoStateMachine} />)).not.toContain("heuristic");
  });
});

describe("machine list and selection", () => {
  const machines = machinesOf([hubConnectionMachine, twoStateMachine, { type: "table", id: "t", title: "t", columns: [], rows: [] }]);

  it("lists holder, states and transitions, marking the selected one", () => {
    const html = renderToStaticMarkup(<MachineList machines={machines} selectedId="Job.status" onSelect={() => undefined} />);
    expect(machines).toHaveLength(2);
    expect(html).toContain("HubConnection._connectionState");
    expect(html).toContain("6 states · 12 transitions");
    expect(html).toContain("2 states · 2 transitions");
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
  });

  it("switches on click", () => {
    const onSelect = vi.fn();
    const buttons = findAll(<MachineList machines={machines} selectedId="x" onSelect={onSelect} />, (e) => e.type === "button");
    (buttons[1]!.props.onClick as () => void)();
    expect(onSelect).toHaveBeenCalledWith("Job.status");
  });

  it("restores the selection from machine= in the hash, else the first", () => {
    expect(selectMachine(machines, readMachineParam("#/projects/p/view/states?scope=src&machine=Job.status"))).toBe(machines[1]);
    expect(selectMachine(machines, null)).toBe(machines[0]);
    expect(selectMachine(machines, "nope")).toBe(machines[0]);
  });

  it("writes machine= beside the other hash parameters", () => {
    expect(withMachineParam("#/projects/p/view/states?scope=src", "Job.status")).toBe("#/projects/p/view/states?scope=src&machine=Job.status");
    expect(withMachineParam("#/projects/p/view/states", "A.b")).toBe("#/projects/p/view/states?machine=A.b");
    expect(withMachineParam("#/projects/p/view/states?machine=A&scope=x", "B")).toBe("#/projects/p/view/states?machine=B&scope=x");
    expect(withMachineParam("#/projects/p/view/states?machine=A", null)).toBe("#/projects/p/view/states");
    expect(readMachineParam(withMachineParam("#/x", "Job.status"))).toBe("Job.status");
  });

  it("lists every site of a transition with function, line link, guard and confidence", () => {
    const t = hubConnectionMachine.transitions.find((x) => x.sites.length === 2)!;
    const onShow = vi.fn();
    const el = <SiteList view={hubConnectionMachine} transition={t} onShow={onShow} />;
    const html = renderToStaticMarkup(el);
    expect(html).toContain("src/HubConnection.ts:732");
    expect(html).toContain("src/HubConnection.ts:761");
    expect(html).toContain("guard: state === Reconnecting");
    expect(html).toContain("no guard");
    expect(html).toContain("exact");
    const links = findAll(el, (e) => e.type === "button");
    (links[0]!.props.onClick as () => void)();
    expect(onShow.mock.calls[0]![0]).toEqual(t.sites[0]!.span);
  });
});

describe("table spans", () => {
  const table: TableView = {
    type: "table",
    id: "transitions",
    title: "Transitions",
    columns: ["from", "to"],
    rows: [["a", "b"], ["b", "c"]],
    spans: [{ file: "src/x.ts", start: [4, 0], end: [4, 9] }, null],
  };

  it("adds a line column with a file:line button that calls onShow", () => {
    const onShow = vi.fn();
    const el = <ViewBlock view={table} projectId="p" onPick={() => undefined} onShow={onShow} />;
    const html = renderToStaticMarkup(el);
    expect(html).toContain("<th>line</th>");
    expect(html).toContain("src/x.ts:5");
    const buttons = findAll(el, (e) => e.type === "button");
    expect(buttons).toHaveLength(1);
    (buttons[0]!.props.onClick as () => void)();
    expect(onShow.mock.calls[0]![0]).toEqual(table.spans![0]);
  });

  it("leaves a table without spans as it was", () => {
    const html = renderToStaticMarkup(<ViewBlock view={{ ...table, spans: undefined }} projectId="p" onPick={() => undefined} onShow={() => undefined} />);
    expect(html).not.toContain("<th>line</th>");
    expect(html).not.toContain("<button");
  });
});
