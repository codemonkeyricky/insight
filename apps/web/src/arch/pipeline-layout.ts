import type { PipelineModel, PipelinePoint, SystemComponent, SystemEdge, SystemModel } from "@insight/model";
import type { LayoutOptions } from "./system-layout";

// The Pipeline view is drawn by the System view's machinery. This file turns a PipelineModel into the SystemModel that
// layoutSystem expects (columns are stages, there are no routes and no outside systems), names the columns, lists the points
// for the side panel, and folds the host's same-column calls into a note on its card. Pure: no React, no browser globals.

export interface PipelineSystem {
  sys: SystemModel;
  /** The layout options the view passes to layoutSystem: column titles and the host card's note. */
  layout: LayoutOptions;
}

/** The last path segment of a component's path: "packages/indexer" → "indexer". */
const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
/** The last two path segments: "packages/core/ir" → "core/ir". */
const shortPath = (path: string): string => path.split("/").slice(-2).join("/");

/** The point that draws a component: the first point, in pipeline order, that lists it. The layout gives each component one column. */
export function ownerPoint(p: PipelineModel, component: string): PipelinePoint | undefined {
  return p.points.find((q) => q.components.includes(component));
}

/**
 * The column titles: a point's column is "<Label> ×<n> · <members>" for its n components ("Frontends ×3 · detect, extract");
 * the host's column is "Host · <host package>" ("Host · indexer").
 */
export function pipelineTitles(p: PipelineModel): string[] {
  const hostComp = p.components.find((c) => c.id === p.host);
  const hostName = hostComp !== undefined ? basename(hostComp.path) : basename(p.host ?? "");
  return p.columns.map((col) => {
    if (p.host !== undefined && col.includes(p.host)) return `Host · ${hostName}`;
    const owner = ownerPoint(p, col[0] ?? "");
    const members = owner !== undefined && owner.members.length > 0 ? ` · ${owner.members.join(", ")}` : "";
    return `${owner?.label ?? "Components"} ×${col.length}${members}`;
  });
}

/** The column index of each drawn component. */
function columnIndex(p: PipelineModel): Map<string, number> {
  const out = new Map<string, number>();
  p.columns.forEach((col, i) => col.forEach((c) => out.set(c, i)));
  return out;
}

/** The host's calls to components in its own column, as "core/ir" or "core/ir ×3", in component order. */
export function hostCalls(p: PipelineModel): string[] {
  const path = new Map(p.components.map((c) => [c.id, c.path] as const));
  return p.edges
    .filter((e) => e.verb === "calls" && e.from === p.host)
    .sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0))
    .map((e) => `${shortPath(path.get(e.to) ?? e.to)}${e.count > 1 ? ` ×${e.count}` : ""}`);
}

/**
 * The System-shaped model of a Pipeline model, and its layout options. An edge whose two ends share a column is not drawn: the
 * host's calls to its own column become the host card's note ("uses ir, model, sdk"), and the summary lists them.
 */
export function pipelineSystem(p: PipelineModel): PipelineSystem {
  const components: SystemComponent[] = p.components;
  const col = columnIndex(p);
  const path = new Map(p.components.map((c) => [c.id, c.path] as const));
  const sameColumn = (e: { from: string; to: string }) => col.get(e.from) === col.get(e.to);
  const edges: SystemEdge[] = p.edges
    .filter((e) => !sameColumn(e))
    .map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      verb: e.verb,
      label: e.label,
      count: e.count,
      sites: e.sites,
      confidence: e.confidence,
    }));
  const names = p.edges
    .filter((e) => sameColumn(e) && e.from === p.host)
    .map((e) => basename(path.get(e.to) ?? e.to))
    .sort();
  const notes = new Map<string, string>();
  if (p.host !== undefined && names.length > 0) notes.set(p.host, `uses ${names.join(", ")}`);
  return {
    sys: {
      scope: p.scope,
      components,
      routes: [],
      externals: [],
      edges,
      stages: p.columns.map((c) => [...c]),
    },
    layout: { titles: pipelineTitles(p), notes },
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
