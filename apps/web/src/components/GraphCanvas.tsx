import { useEffect, useRef } from "react";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import type { GraphView } from "../api";
import { nodeText, OUTSIDE_SCOPE } from "../scopeLenses";
import { tokenValue } from "../theme";

export interface GraphPick {
  kind: "node" | "edge";
  /** Element id in the canvas. For an edge this is only a position, so use key to refer to it. */
  id: string;
  /** Stable key for annotations: the node id, or from|kind|to for an edge. */
  key: string;
  label: string;
  span?: GraphView["edges"][number]["span"];
}

/** The stable key of an edge in a graph view. Two edges with the same ends and kind share it. */
export const edgeKey = (e: { from: string; kind: string; to: string }) => `${e.from}|${e.kind}|${e.to}`;

/**
 * The Cytoscape stylesheet, read from the design tokens so the graph follows the theme. Cytoscape needs
 * plain colour values, so each token is read from the root element; the tokens used here are all solid.
 */
function graphStyle(): cytoscape.StylesheetJson {
  const ink = tokenValue("--ink");
  const accent = tokenValue("--accent");
  const graphite = tokenValue("--graphite");
  const coroutine = tokenValue("--coroutine");
  const ok = tokenValue("--switch-on");
  const red = tokenValue("--red");
  const sheet = tokenValue("--sheet");
  return [
    {
      selector: "node",
      style: {
        label: "data(label)",
        "font-size": 10,
        color: ink,
        "text-valign": "bottom",
        "text-margin-y": 4,
        "background-color": accent,
        width: 14,
        height: 14,
        "text-wrap": "none",
        "text-outline-color": sheet,
        "text-outline-width": 2,
      },
    },
    {
      selector: "edge",
      style: {
        width: 1.5,
        "line-color": graphite,
        "target-arrow-color": graphite,
        "target-arrow-shape": "triangle",
        "curve-style": "bezier",
      },
    },
    { selector: "edge[kind = 'call']", style: { "line-style": "dashed", "line-color": coroutine, "target-arrow-color": coroutine } },
    { selector: "edge[?hasSpan]", style: { "line-color": ok, "target-arrow-color": ok, width: 2.5 } },
    { selector: "node[?outside]", style: { "background-color": graphite, color: graphite } },
    { selector: ":selected", style: { "background-color": red, "line-color": red, "target-arrow-color": red } },
  ];
}

/** Cytoscape view of a graph lens view. Clicking an edge or node reports it through onPick. */
export function GraphCanvas({ view, onPick }: { view: GraphView; onPick: (pick: GraphPick) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const cyRef = useRef<Core | null>(null);

  // Restyle when the theme changes: the data-theme attribute (set by the header switch) or the OS scheme in "system".
  useEffect(() => {
    const restyle = () => {
      const cy = cyRef.current;
      if (cy) cy.style().fromJson(graphStyle()).update();
    };
    const observer = new MutationObserver(restyle);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const scheme = window.matchMedia?.("(prefers-color-scheme: dark)");
    scheme?.addEventListener("change", restyle);
    return () => {
      observer.disconnect();
      scheme?.removeEventListener("change", restyle);
    };
  }, []);

  useEffect(() => {
    const host = container.current as (HTMLDivElement & { __cy?: Core }) | null;
    if (!host) return;
    const elements: ElementDefinition[] = [
      ...view.nodes.map((n) => ({ data: { id: n.id, label: nodeText(n.label), full: n.label, outside: n.group === OUTSIDE_SCOPE } })),
      ...view.edges.map((e, i) => ({
        data: {
          id: `e${i}`,
          source: e.from,
          target: e.to,
          kind: e.kind,
          hasSpan: e.span !== undefined,
          span: e.span,
          confidence: e.confidence ?? "",
        },
      })),
    ];
    const cy: Core = cytoscape({
      container: host,
      elements,
      style: graphStyle(),
      layout: { name: "cose", animate: false, padding: 24, nodeRepulsion: () => 9000 } as cytoscape.LayoutOptions,
      wheelSensitivity: 0.3,
    });
    cy.on("tap", "edge", (evt) => {
      const d = evt.target.data() as { id: string; source: string; target: string; kind: string; span?: GraphView["edges"][number]["span"] };
      pickRef.current({
        kind: "edge",
        id: d.id,
        key: edgeKey({ from: d.source, kind: d.kind, to: d.target }),
        label: `${d.source} ${d.kind === "call" ? "calls" : "imports"} ${d.target}`,
        span: d.span,
      });
    });
    cy.on("tap", "node", (evt) => {
      const d = evt.target.data() as { id: string; full: string };
      pickRef.current({ kind: "node", id: d.id, key: d.id, label: d.full });
    });
    // Exposed on the container so browser tests can find an edge's on-screen position and click it.
    host.__cy = cy;
    cyRef.current = cy;
    return () => {
      // React clears container.current before this runs, so the element is held in `host`.
      delete host.__cy;
      cyRef.current = null;
      cy.destroy();
    };
  }, [view]);

  return <div ref={container} className="graph" role="img" aria-label={`${view.title} graph`} />;
}
