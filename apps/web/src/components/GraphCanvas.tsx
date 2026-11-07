import { useEffect, useRef } from "react";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import type { GraphView } from "../api";
import { nodeText, OUTSIDE_SCOPE } from "../scopeLenses";

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

const STYLE: cytoscape.StylesheetJson = [
  {
    selector: "node",
    style: {
      label: "data(label)",
      "font-size": 10,
      color: "#1d2433",
      "text-valign": "bottom",
      "text-margin-y": 4,
      "background-color": "#3b6fd1",
      width: 14,
      height: 14,
      "text-wrap": "none",
    },
  },
  {
    selector: "edge",
    style: {
      width: 1.5,
      "line-color": "#8a94a6",
      "target-arrow-color": "#8a94a6",
      "target-arrow-shape": "triangle",
      "curve-style": "bezier",
    },
  },
  { selector: "edge[kind = 'call']", style: { "line-style": "dashed", "line-color": "#c08a2b", "target-arrow-color": "#c08a2b" } },
  { selector: "edge[?hasSpan]", style: { "line-color": "#2f7d5b", "target-arrow-color": "#2f7d5b", width: 2.5 } },
  { selector: "node[?outside]", style: { "background-color": "#9aa3b2", color: "#5d6678" } },
  { selector: ":selected", style: { "background-color": "#d1493b", "line-color": "#d1493b", "target-arrow-color": "#d1493b" } },
];

/** Cytoscape view of a graph lens view. Clicking an edge or node reports it through onPick. */
export function GraphCanvas({ view, onPick }: { view: GraphView; onPick: (pick: GraphPick) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

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
      style: STYLE,
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
    return () => {
      // React clears container.current before this runs, so the element is held in `host`.
      delete host.__cy;
      cy.destroy();
    };
  }, [view]);

  return <div ref={container} className="graph" role="img" aria-label={`${view.title} graph`} />;
}
