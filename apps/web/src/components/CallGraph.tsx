import { useEffect, useMemo, useRef, useState } from "react";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import { NODE_CELL, graphGrid, type CallGraph, type GraphNode } from "../flowGraph";

/** The colours the canvas draws with. Cytoscape cannot read CSS variables, so the page's tokens are read once per theme. */
interface Palette {
  bg: string;
  panel: string;
  fg: string;
  muted: string;
  line: string;
  accent: string;
  ok: string;
  warn: string;
  /** One colour per file, given out in turn, so the functions of one file read as a band. */
  bands: string[];
}

const COLOURS = ["bg", "panel", "fg", "muted", "line", "accent", "ok", "warn"] as const;
const FALLBACK: Palette = {
  bg: "#f6f7f9",
  panel: "#ffffff",
  fg: "#1d2433",
  muted: "#5d6578",
  line: "#d9dde6",
  accent: "#3b6fd1",
  ok: "#2f7d5b",
  warn: "#a86b00",
  bands: ["#e6eefb", "#e7f4ec", "#fbf1de", "#f1e8f7", "#fbe7e4", "#e3f2f4"],
};

/** The space left around the grid inside the canvas, so a node at the edge is not cut. */
const PAD = 14;

function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const out: Palette = { ...FALLBACK, bands: [...FALLBACK.bands] };
  for (const k of COLOURS) {
    const value = css.getPropertyValue(`--${k}`).trim();
    if (value) out[k] = value;
  }
  out.bands = FALLBACK.bands.map((fallback, i) => css.getPropertyValue(`--band-${i}`).trim() || fallback);
  return out;
}

function stylesFor(p: Palette): cytoscape.StylesheetJson {
  return [
    {
      selector: "node",
      style: {
        label: "data(label)",
        "font-size": 11,
        color: p.fg,
        "background-color": "data(color)",
        "border-color": p.muted,
        "border-width": 1,
        shape: "round-rectangle",
        width: NODE_CELL.w,
        height: NODE_CELL.h,
        "text-valign": "center",
        "text-halign": "center",
        "text-wrap": "wrap",
        "text-max-width": `${NODE_CELL.w - 14}px`,
      },
    },
    { selector: "node[kind = 'module']", style: { "border-color": p.ok, "border-style": "dotted" } },
    { selector: "node[?entry]", style: { "border-color": p.accent, "border-width": 3 } },
    { selector: "node[?calledFromOutside]", style: { "border-style": "double", "border-width": 4, "border-color": p.warn } },
    { selector: "node[kind = 'external']", style: { "background-color": p.panel, color: p.muted, "border-style": "dashed", "border-color": p.muted } },
    {
      selector: "edge",
      style: {
        width: 1.5,
        "line-color": p.muted,
        "target-arrow-color": p.muted,
        "target-arrow-shape": "triangle",
        "curve-style": "bezier",
        label: "data(label)",
        "font-size": 10,
        color: p.fg,
        "text-background-color": p.panel,
        "text-background-opacity": 1,
        "text-background-padding": "2px",
      },
    },
    { selector: "edge[?external]", style: { "line-style": "dashed" } },
    { selector: "edge[?candidate]", style: { "line-style": "dotted" } },
    { selector: ".faded", style: { opacity: 0.15 } },
  ];
}

/** The longest line a node shows, in characters. Two lines of this fit the node's width at its font size. */
const LINE = 26;

/** The start of a text, cut to `max` characters with an ellipsis at the end. */
function head(text: string, max = LINE): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The end of a text, cut to `max` characters with an ellipsis at the start, so the last part of a path shows. */
function tail(text: string, max = LINE): string {
  return text.length <= max ? text : `…${text.slice(text.length - max + 1)}`;
}

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dirName = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** The text a node shows: its name on the first line, and where it sits on the second. */
function nodeText(n: GraphNode): string {
  if (n.kind === "external") return `${head(n.name)} ↗`;
  if (n.kind === "file") return `${head(baseName(n.name))}\n${tail(dirName(n.name))}`;
  return `${n.kind === "module" ? "module code" : head(n.name)}\n${tail(n.file ?? "")}`;
}

/** The colour of each file's band: files in name order take the palette in turn. */
function bandColours(graph: CallGraph, bands: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const files = [...new Set(graph.nodes.flatMap((n) => (n.file === undefined ? [] : [n.file])))].sort();
  files.forEach((file, i) => {
    const colour = bands[i % bands.length];
    if (colour !== undefined) out.set(file, colour);
  });
  return out;
}

/** Hides nodes that match no word of the filter, and the edges that connect two hidden nodes. */
function applyFilter(cy: Core, query: string) {
  const q = query.trim().toLowerCase();
  const titleOf = (el: { data(key: string): unknown }) => String(el.data("title")).toLowerCase();
  const hit = (n: cytoscape.NodeSingular) => q === "" || titleOf(n).includes(q);
  cy.batch(() => {
    cy.nodes().forEach((n) => {
      n.toggleClass("faded", !hit(n));
    });
    cy.edges().forEach((e) => {
      e.toggleClass("faded", e.source().hasClass("faded") && e.target().hasClass("faded"));
    });
  });
}

/**
 * The call graph of a folder or the project. Each node sits in the layer of its depth below the roots, so each
 * call points down the page; a layer wraps into rows, and one file's functions sit together in a colour band.
 * The graph is drawn at full size in a box that scrolls. A click opens the function, file or callee it names.
 */
export function CallGraphView({ graph, title }: { graph: CallGraph; title: string }) {
  const container = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const queryRef = useRef("");
  const [query, setQuery] = useState("");
  const [theme, setTheme] = useState(0);
  const grid = useMemo(() => graphGrid(graph), [graph]);

  // The colours are read when the canvas is made, so it is made again when the system theme changes.
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const bump = () => setTheme((t) => t + 1);
    mq.addEventListener("change", bump);
    return () => mq.removeEventListener("change", bump);
  }, []);

  useEffect(() => {
    const host = container.current as (HTMLDivElement & { __cy?: Core }) | null;
    if (!host) return;
    const p = readPalette();
    const colours = bandColours(graph, p.bands);
    const elements: ElementDefinition[] = [
      ...graph.nodes.map((n) => {
        const at = grid.at.get(n.key) ?? { x: 0, y: 0 };
        return {
          data: {
            id: n.key,
            label: nodeText(n),
            title: n.title,
            kind: n.kind,
            href: n.href,
            entry: n.entry,
            calledFromOutside: n.calledFromOutside,
            color: n.kind === "external" ? p.panel : (colours.get(n.file ?? "") ?? p.panel),
          },
          // The grid gives a node's top-left corner; Cytoscape places a node by its centre.
          position: { x: at.x + NODE_CELL.w / 2 + PAD, y: at.y + NODE_CELL.h / 2 + PAD },
        };
      }),
      ...graph.edges.map((e) => ({
        data: { id: e.key, source: e.from, target: e.to, label: e.count > 1 ? String(e.count) : "", external: e.external, candidate: e.candidate },
      })),
    ];
    // Positions are fixed and drawn at full size, so the box scrolls rather than the graph shrinking to fit.
    const cy: Core = cytoscape({
      container: host,
      elements,
      style: stylesFor(p),
      layout: { name: "preset", fit: false } as cytoscape.LayoutOptions,
      userZoomingEnabled: false,
      userPanningEnabled: false,
      boxSelectionEnabled: false,
    });
    cy.on("tap", "node", (evt) => {
      const href = evt.target.data("href") as string | undefined;
      if (href) window.location.hash = href;
    });
    cyRef.current = cy;
    applyFilter(cy, queryRef.current);
    // Cytoscape keeps where the canvas sits on the page and reads it again only on a resize. A scroll moves the
    // canvas without one, so each scroll asks for a fresh reading; otherwise a tap lands on the wrong node.
    const scroller = host.parentElement;
    const refresh = () => cy.resize();
    scroller?.addEventListener("scroll", refresh, { passive: true });
    window.addEventListener("scroll", refresh, { passive: true });
    // Exposed on the container so browser tests can find a node and click it.
    host.__cy = cy;
    return () => {
      scroller?.removeEventListener("scroll", refresh);
      window.removeEventListener("scroll", refresh);
      // React clears container.current before this runs, so the element is held in `host`.
      delete host.__cy;
      cyRef.current = null;
      cy.destroy();
    };
  }, [graph, grid, theme]);

  return (
    <section>
      <div className="graph-tools">
        <input
          type="search"
          aria-label="Filter the call graph"
          placeholder="Filter by name or file"
          value={query}
          onChange={(e) => {
            queryRef.current = e.target.value;
            setQuery(e.target.value);
            if (cyRef.current) applyFilter(cyRef.current, e.target.value);
          }}
        />
      </div>
      <div className="graph-scroll">
        <div
          ref={container}
          className="call-graph"
          role="img"
          aria-label={`${title} call graph`}
          style={{ width: grid.width + 2 * PAD, height: grid.height + 2 * PAD }}
        />
      </div>
      <ul className="legend-keys small" aria-label="Legend">
        <li>
          <span className="key" aria-hidden="true" />
          Function or file, coloured by file
        </li>
        <li>
          <span className="key key-module" aria-hidden="true" />
          Module code
        </li>
        <li>
          <span className="key key-entry" aria-hidden="true" />
          Entry: nothing calls it
        </li>
        <li>
          <span className="key key-outside" aria-hidden="true" />
          Called from outside this scope
        </li>
        <li>
          <span className="key key-external" aria-hidden="true" />
          Outside this scope
        </li>
        <li>A number on an arrow: the calls it stands for, when more than one.</li>
      </ul>
    </section>
  );
}
