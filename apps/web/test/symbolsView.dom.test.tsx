// @vitest-environment jsdom
// The Symbols tab's chain: a start list opens a box, a callee opens the box to its right and drops the old tail, and the
// Callers chip opens the callers box, whose caller becomes the new head of the chain.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { buildProjectModel, type ProjectModel } from "@insight/model";
import { SymbolsView } from "../src/components/symbols/SymbolsView";

const { getSymbolModel, showCode } = vi.hoisted(() => ({ getSymbolModel: vi.fn(), showCode: vi.fn() }));
vi.mock("../src/api", () => ({ api: { getSymbolModel } }));
vi.mock("../src/codeTarget", () => ({
  fileTarget: (file: string, line?: number) => ({ kind: "file", path: file, line }),
  useCodeTarget: () => ({ target: undefined, showCode }),
}));

const P = { frontend: "test", confidence: "exact" as const };
const F = "src/app.ts";
const G = "src/lib.ts";
const id = (file: string, name: string) => `${file}#${name}`;

/**
 * A project: A (exported) calls B directly and C through the internal helper H; B (exported) calls D (exported). Only A calls B.
 */
function model(): ProjectModel {
  const fn = (file: string, name: string, exported: boolean, line: number) => ({
    id: id(file, name),
    facet: "structure",
    kind: "structure.function",
    parent: file,
    span: { file, start: [line, 0] as [number, number], end: [line + 2, 1] as [number, number] },
    attrs: exported ? { name, exported: true } : { name },
    provenance: P,
  });
  const call = (from: string, to: string) => ({
    from,
    to,
    facet: "calls",
    kind: "calls.call",
    span: { file: F, start: [3, 2] as [number, number], end: [3, 6] as [number, number] },
    provenance: P,
  });
  const doc = {
    nodes: [
      { id: F, facet: "structure", kind: "structure.file", attrs: { path: F }, provenance: P },
      { id: G, facet: "structure", kind: "structure.file", attrs: { path: G }, provenance: P },
      fn(F, "A", true, 1),
      fn(F, "H", false, 6),
      fn(G, "B", true, 1),
      fn(G, "C", true, 6),
      fn(G, "D", true, 12),
    ],
    edges: [call(id(F, "A"), id(G, "B")), call(id(F, "A"), id(F, "H")), call(id(F, "H"), id(G, "C")), call(id(G, "B"), id(G, "D"))],
    findings: [],
  } as unknown as Parameters<typeof buildProjectModel>[0];
  return buildProjectModel(doc);
}

/** The box whose label is `Calls of <name>`. */
const box = (name: string) => screen.queryByRole("region", { name: `Calls of ${name}` });

async function ready(chain?: string) {
  render(<SymbolsView id="p" scope="" chain={chain} />);
  await screen.findByRole("complementary", { name: "Exported functions" });
}

afterEach(() => {
  cleanup();
  getSymbolModel.mockReset();
  showCode.mockReset();
  window.location.hash = "";
});

describe("Symbols tab chain", () => {
  it("opens a function's box from the start list, and lists its exported callees", async () => {
    getSymbolModel.mockResolvedValue(model());
    await ready();
    expect(screen.getByText("Pick an exported function on the left to open its calls.")).toBeTruthy();
    fireEvent.click(within(screen.getByRole("complementary", { name: "Exported functions" })).getByRole("button", { name: "A" }));
    const a = box("A") as HTMLElement;
    expect(a).not.toBeNull();
    const rows = within(a).getAllByRole("button").filter((b) => b.classList.contains("sym-row"));
    expect(rows.map((r) => r.querySelector(".sym-row-name")?.textContent)).toEqual(["B", "C"]);
    expect(rows.find((r) => r.querySelector(".sym-row-name")?.textContent === "C")?.textContent).toContain("via H");
    expect(window.location.hash).toContain("chain=");
  });

  it("a callee opens its box to the right and drops the boxes that were right of the old one", async () => {
    getSymbolModel.mockResolvedValue(model());
    await ready();
    fireEvent.click(within(screen.getByRole("complementary", { name: "Exported functions" })).getByRole("button", { name: "A" }));
    fireEvent.click(within(box("A") as HTMLElement).getByRole("button", { name: /^B/ }));
    // B's box opens right of A, and its row for D is the next callee.
    expect(box("B")).not.toBeNull();
    fireEvent.click(within(box("B") as HTMLElement).getByRole("button", { name: /^D/ }));
    expect(box("D")).not.toBeNull();
    // A callee of A (C, through H) replaces B and D: the chain is now A, C.
    fireEvent.click(within(box("A") as HTMLElement).getByRole("button", { name: /^C\b/ }));
    expect(box("C")).not.toBeNull();
    expect(box("B")).toBeNull();
    expect(box("D")).toBeNull();
    expect(decodeURIComponent(window.location.hash)).toContain(`chain=${id(F, "A")},${id(G, "C")}`);
  });

  it("clicking the selected callee again closes everything right of its box", async () => {
    getSymbolModel.mockResolvedValue(model());
    await ready(`${id(F, "A")},${id(G, "B")}`);
    expect(box("B")).not.toBeNull();
    fireEvent.click(within(box("A") as HTMLElement).getByRole("button", { name: /^B/ }));
    expect(box("B")).toBeNull();
    expect(box("A")).not.toBeNull();
  });

  it("the Callers chip opens the callers box, and clicking a caller makes it the head of the chain", async () => {
    getSymbolModel.mockResolvedValue(model());
    await ready(id(G, "B"));
    expect(box("B")).not.toBeNull();
    const chip = within(box("B") as HTMLElement).getByRole("button", { name: "Callers 1" });
    fireEvent.click(chip);
    const callers = screen.getByRole("region", { name: "Callers of B" });
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(within(callers).getByRole("button", { name: /^A/ }));
    // The caller A is now the head, with B still right of it; the callers box has closed.
    expect(screen.queryByRole("region", { name: "Callers of B" })).toBeNull();
    expect(box("A")).not.toBeNull();
    const b = within(box("A") as HTMLElement).getByRole("button", { name: /^B/ });
    expect(b.getAttribute("aria-pressed")).toBe("true");
    expect(decodeURIComponent(window.location.hash)).toContain(`chain=${id(F, "A")},${id(G, "B")}`);
  });

  it("restores the chain from the URL on load, and drops an id that is not an exported function", async () => {
    getSymbolModel.mockResolvedValue(model());
    await ready(`${id(F, "A")},${id(G, "B")},nope.ts#missing`);
    expect(box("A")).not.toBeNull();
    expect(box("B")).not.toBeNull();
    expect(screen.queryByText("nope.ts#missing")).toBeNull();
  });

  it("the header opens the function's source in the code pane", async () => {
    getSymbolModel.mockResolvedValue(model());
    await ready(id(G, "B"));
    fireEvent.click(within(box("B") as HTMLElement).getByRole("button", { name: /Show the source|^B/, hidden: true }) as HTMLElement);
    expect(showCode).toHaveBeenCalledWith({ kind: "file", path: G, line: 2 });
  });
});
