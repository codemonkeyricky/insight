import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildExecScene, type ExecFunctionRef, type ExecModel, type ExecModelStats, type ExecThread } from "@insight/flow";
import { CallLists, ExecChips, ExecTable, ExecTrail, type ListBase } from "../src/components/zoom/ExecLists";
import { ExecContainerPanel } from "../src/components/zoom/ExecContainerPanel";
import { ExecFunctionPanel } from "../src/components/zoom/ExecFunctionPanel";
import { ZoomStore } from "../src/zoom/scene";
import { execCallLists, execChips, execIndex, execRows, execSelected, execTrail } from "../src/zoom/execMap";

// The panels render to static markup: effects do not run, so the store is never asked for a chart or a flow.

const fn = (id: string, file: string, line: number, runtime: ExecFunctionRef["runtime"] = "thread"): ExecFunctionRef => ({
  id,
  name: id,
  file,
  line,
  inScope: true,
  runtime,
});

const stats: ExecModelStats = {
  threads: 1,
  programs: 0,
  locks: 0,
  channels: 0,
  spawns: 0,
  resolved: 0,
  outside: 0,
  unresolved: 0,
  candidates: 0,
  coroutines: 0,
  dispatches: 0,
  functionsInScope: 4,
  functionsThreaded: 4,
  functionsCoroutineOnly: 0,
  functionsUnthreaded: 0,
  functionsListed: 4,
};

// main calls helper; helper calls leaf; nothing calls main. All on the main thread.
const model = (): ExecModel => {
  const main: ExecThread = {
    id: "main",
    kind: "main",
    roots: ["main"],
    reach: 3,
    reached: ["helper", "leaf", "main"],
    coroutines: [],
    coroutineOnly: [],
  };
  return {
    scope: "src",
    truncated: false,
    functions: [fn("main", "src/app.ts", 1), fn("helper", "src/app.ts", 5), fn("leaf", "src/lib.ts", 9)],
    threads: [main],
    dispatches: [],
    programs: [],
    resources: [],
    calls: [
      [0, 1],
      [1, 2],
    ],
    unthreaded: [],
    stats: { ...stats, functionsListed: 3 },
  };
};

const base: ListBase = { id: "p1", scope: "src", roots: false, onOpen: () => {} };

describe("the trail", () => {
  it("links each step to its placement, and leaves the focused function in bold", () => {
    const m = model();
    const scene = buildExecScene(m);
    const index = execIndex(scene, m);
    const steps = execTrail(index, "thread:main>leaf") ?? [];
    const html = renderToStaticMarkup(<ExecTrail base={base} steps={steps} />);
    expect(html).toContain('aria-label="Call path"');
    expect(html).toContain("<strong>leaf</strong>");
    expect(html).toContain('href="#/projects/p1/view/flow?scope=src&amp;fn=main"');
    expect(html).toContain("›");
  });
});

describe("the call lists", () => {
  it("say so for an empty list, and cap a long one with a count", () => {
    const m = model();
    const scene = buildExecScene(m);
    const index = execIndex(scene, m);
    const html = renderToStaticMarkup(<CallLists base={base} lists={execCallLists(index, "thread:main>leaf")} />);
    expect(html).toContain("Calls nothing in this scope.");
    expect(html).toContain("Called by");
    expect(html).toContain("helper");
    const text = renderToStaticMarkup(
      <CallLists base={base} lists={{ calls: { items: [], more: 0 }, calledBy: { items: [{ id: "x", name: "x", file: "a.ts", line: 2 }], more: 7 } }} />,
    );
    expect(text).toContain("Calls nothing in this scope.");
    expect(text).toContain("and 7 more");
    const none = renderToStaticMarkup(<CallLists base={base} lists={{ calls: { items: [], more: 0 }, calledBy: { items: [], more: 0 } }} />);
    expect(none).toContain("Nothing in this scope calls it.");
    // A caller with no placement shows its file, and no link.
    expect(text).toContain("in <span class=\"mono\">a.ts:2</span>");
    expect(text).not.toContain("<a ");
  });
});

describe("the chips and the table", () => {
  it("draws a pill per function, with the rest counted", () => {
    const m = model();
    const scene = buildExecScene(m);
    const html = renderToStaticMarkup(<ExecChips base={base} label="Functions" chips={execChips(scene, "thread:main").items} more={0} />);
    expect(html).toContain('class="chip"');
    expect(html).toContain('aria-label="Functions"');
    expect(html).toContain(">main</a>");
  });

  it("shows the flow columns only when they are given, and dashes a missing count", () => {
    const m = model();
    const scene = buildExecScene(m);
    const index = execIndex(scene, m);
    const plain = renderToStaticMarkup(<ExecTable base={base} rows={execRows(index, "thread:main")} flow={false} />);
    expect(plain).toContain(">Calls</button>");
    expect(plain).not.toContain("Steps");
    const flow = renderToStaticMarkup(
      <ExecTable base={base} rows={execRows(index, "thread:main", new Map([["main", { steps: 3, decisions: 1, loops: 0 }]]))} flow={true} />,
    );
    expect(flow).toContain("Steps");
    expect(flow).toContain("Decisions");
    expect(flow).toContain("Loops");
    expect(flow).toContain("—");
    expect(flow).toContain('class="break-any mono small"');
    expect(flow).toContain("src/app.ts:1");
  });
});

describe("the panels", () => {
  it("renders a function's trail above its heading and its call lists below its chart", () => {
    const m = model();
    const scene = buildExecScene(m);
    const index = execIndex(scene, m);
    const selected = execSelected(scene, new Map(m.functions.map((f) => [f.id, f])), "thread:main>leaf");
    if (selected === undefined) throw new Error("no selection");
    const html = renderToStaticMarkup(
      <ExecFunctionPanel
        id="p1"
        scope="src"
        roots={false}
        store={new ZoomStore("p1")}
        index={index}
        nodeId="thread:main>leaf"
        selected={selected}
        onOpen={() => {}}
      />,
    );
    expect(html.indexOf('aria-label="Call path"')).toBeLessThan(html.indexOf("<h2>leaf</h2>"));
    expect(html).toContain("Runs on Main thread");
    expect(html).toContain("Calls nothing in this scope.");
    expect(html).toContain("Called by");
  });

  it("renders a container's heading, pills and table, and a program's heading alone", () => {
    const m = model();
    const scene = buildExecScene(m);
    const index = execIndex(scene, m);
    const thread = renderToStaticMarkup(
      <ExecContainerPanel id="p1" scope="src" roots={false} store={new ZoomStore("p1")} index={index} nodeId="thread:main" onOpen={() => {}} />,
    );
    expect(thread).toContain("Main thread");
    expect(thread).toContain('class="kind thread"');
    expect(thread).toContain("Per function");
    expect(thread).toContain("exec-table");
    const program = renderToStaticMarkup(
      <ExecContainerPanel id="p1" scope="src" roots={false} store={new ZoomStore("p1")} index={index} nodeId={scene.root} onOpen={() => {}} />,
    );
    expect(program).toContain("Program");
    expect(program).not.toContain("exec-table");
  });
});
