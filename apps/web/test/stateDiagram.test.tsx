import { createRequire } from "node:module";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ElkNode } from "elkjs/lib/elk-api";
import { Legend, MIN_SCALE, MachineSvg, arcName, arcTitle, fitScale, type MachinePick } from "../src/components/StateDiagram";
import { MachineList, SiteList } from "../src/components/MachineSection";
import { ViewBlock } from "../src/pages/LensPage";
import { layoutMachine, withTimeout, type Solve } from "../src/states/layout";
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
    expect(l).toContain("exact write");
    expect(l).toContain("dashed = inferred: written after an await, or start state taken from the callers");
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

describe("per-site confidence (nit 15)", () => {
  it("shows each site's own confidence", () => {
    const t = hubConnectionMachine.transitions.find((x) => x.sites.length === 2)!;
    const mixed = { ...t, confidence: "exact" as const, sites: [{ ...t.sites[0]!, confidence: "exact" as const }, { ...t.sites[1]!, confidence: "heuristic" as const }] };
    const html = renderToStaticMarkup(<SiteList view={hubConnectionMachine} transition={mixed} onShow={vi.fn()} />);
    expect(html).toContain("heuristic");
    expect(html).toContain("exact");
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

describe("fit scale", () => {
  it("never goes above 1, so a small machine is not drawn huge", () => {
    expect(fitScale(200, 150, 1000, 800)).toBe(1);
  });
  it("never goes below the minimum, so a narrow pane scrolls instead of shrinking", () => {
    expect(fitScale(1000, 500, 288, 800)).toBe(MIN_SCALE);
    expect(fitScale(1000, 500, 800, 800)).toBeCloseTo(0.8);
  });
  it("respects the height cap above the minimum", () => {
    expect(fitScale(500, 1000, 1000, 700)).toBeCloseTo(0.7);
  });
  it("renders the svg at an explicit size when given one", () => {
    const html = renderToStaticMarkup(<MachineSvg view={twoStateMachine} laid={{ width: 400, height: 200, states: [], arcs: [] }} size={{ width: 240, height: 120 }} />);
    expect(html).toContain('width="240"');
    expect(html).toContain("max-height:none");
  });
});

describe("arc tooltip", () => {
  it("lists the name and every site's function and file:line", () => {
    const t = hubConnectionMachine.transitions.find((x) => x.sites.some((y) => y.span && y.fn))!;
    const title = arcTitle(hubConnectionMachine, t);
    expect(title.startsWith(arcName(hubConnectionMachine, t))).toBe(true);
    const site = t.sites.find((y) => y.span && y.fn)!;
    expect(title).toContain(`${site.fn} ${site.span!.file}:${site.span!.start[0] + 1}`);
  });
});

describe("withTimeout (risk 14)", () => {
  it("rejects when the solver never settles", async () => {
    vi.useFakeTimers();
    try {
      const p = layoutMachine(hubConnectionMachine, withTimeout(() => new Promise<ElkNode>(() => undefined), 15_000));
      const caught = p.then(() => "ok", (e: Error) => e.message);
      await vi.advanceTimersByTimeAsync(15_001);
      expect(await caught).toMatch(/timed out/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects when the solver errors, and passes a good result through", async () => {
    await expect(layoutMachine(hubConnectionMachine, withTimeout(() => Promise.reject(new Error("worker died"))))).rejects.toThrow("worker died");
    await expect(layoutMachine(hubConnectionMachine, withTimeout(solve))).resolves.toBeTruthy();
  });
});
