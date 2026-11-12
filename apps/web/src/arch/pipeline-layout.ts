import type { PipelineModel, SystemComponent, SystemEdge, SystemModel } from "@insight/model";

// The Pipeline view is drawn by the System view's machinery. This file turns a PipelineModel into the SystemModel that
// layoutSystem expects (columns are stages, there are no routes and no outside systems), names the columns, and lists the
// points for the side panel. Pure: no React, no browser globals.

export interface PipelineSystem {
  sys: SystemModel;
  /** One title per column, left to right. */
  titles: string[];
}

/** The last path segment of a component's path: "packages/indexer" → "indexer". */
const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** The point that draws a component: the first point, in pipeline order, that lists it. The layout gives each component one column. */
export function ownerPoint(p: PipelineModel, component: string): PipelineModel["points"][number] | undefined {
  return p.points.find((q) => q.components.includes(component));
}

/**
 * The column titles: a point's column is "<Label> ×<n>" for its n components ("Frontends ×3", "Lenses ×7"); the host's column is
 * "Host · <host package>" ("Host · indexer").
 */
export function pipelineTitles(p: PipelineModel): string[] {
  const hostComp = p.components.find((c) => c.id === p.host);
  const hostName = hostComp !== undefined ? basename(hostComp.path) : basename(p.host ?? "");
  return p.columns.map((col) => {
    if (p.host !== undefined && col.includes(p.host)) return `Host · ${hostName}`;
    const owner = ownerPoint(p, col[0] ?? "");
    return `${owner?.label ?? "Components"} ×${col.length}`;
  });
}

/** The System-shaped model of a Pipeline model, and its column titles. */
export function pipelineSystem(p: PipelineModel): PipelineSystem {
  const components: SystemComponent[] = p.components;
  const edges: SystemEdge[] = p.edges.map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    verb: e.verb,
    label: e.label,
    count: e.count,
    sites: e.sites,
    confidence: e.confidence,
  }));
  return {
    sys: {
      scope: p.scope,
      components,
      routes: [],
      externals: [],
      edges,
      stages: p.columns.map((col) => [...col]),
    },
    titles: pipelineTitles(p),
  };
}

export interface PipelineRow {
  id: string;
  label: string;
  role: "source" | "sink";
  members: string;
  /** The implementers' labels, in the point's order. */
  components: string[];
  /** The labels of the points whose column draws this point's components, when none of them is drawn under this point. */
  shownUnder?: string;
}

/** The points in pipeline order, with what the side panel shows for each. */
export function pipelineRows(p: PipelineModel): PipelineRow[] {
  const labelOf = new Map(p.components.map((c) => [c.id, c.label] as const));
  return p.points.map((pt) => {
    const owned = pt.components.filter((c) => ownerPoint(p, c) === pt);
    const elsewhere = [...new Set(pt.components.filter((c) => ownerPoint(p, c) !== pt).map((c) => ownerPoint(p, c)?.label ?? ""))].filter((l) => l !== "");
    return {
      id: pt.id,
      label: pt.label,
      role: pt.role,
      members: pt.members.join(", "),
      components: pt.components.map((c) => labelOf.get(c) ?? c),
      ...(owned.length === 0 && elsewhere.length > 0 ? { shownUnder: elsewhere.join(", ") } : {}),
    };
  });
}
