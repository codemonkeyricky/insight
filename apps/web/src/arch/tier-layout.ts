import type { SystemComponent, SystemEdge, SystemExternal, SystemModel, TierEdge, TierModel, TierNode } from "@insight/model";
import type { LayoutOptions } from "./system-layout";

// The Tiers view is drawn by the System view's machinery. This file turns a TierModel into the SystemModel that layoutSystem
// expects: the deployable units are the components (the frontend column, then the backend column), the stores and outside
// services are the outside systems (Storage, then External), and each edge says its verb and label. Pure: no React, no browser
// globals.

export interface TierSystem {
  sys: SystemModel;
  /** The layout options the view passes to layoutSystem: the stage titles, the platform notes, the sub-lines and the outside columns. */
  layout: LayoutOptions;
}

type Role = NonNullable<TierNode["role"]>;

const ROLE_TEXT: Record<Role, string> = { spa: "Browser app", client: "Client program", server: "Server", function: "Function", worker: "Worker" };
const PLATFORM_TEXT: Record<NonNullable<TierNode["platform"]>, string> = {
  browser: "browser",
  node: "local Node",
  vercel: "Vercel Function",
  cloudflare: "Cloudflare Worker",
};

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** A component of the Tiers view: a deployable unit. Its file and function counts are not in the tier model, so they are zero. */
function componentOf(n: TierNode): SystemComponent {
  return { id: n.id, label: n.label, path: n.path ?? n.id, kind: "package", files: 0, functions: 0, entry: n.tier === "frontend" };
}

/** An outside system of the Tiers view: a store (Storage) or a service (External), with the category the layout columns use. */
function externalOf(n: TierNode): SystemExternal {
  const fallback: SystemExternal["category"] = n.tier === "storage" ? "store" : "service";
  return { ...(n.external ?? { id: n.id, label: n.label, category: fallback }), id: n.id, label: n.label };
}

/** An edge as the System view draws it: its label leads with the verb, as the pill text does. */
function edgeOf(e: TierEdge): SystemEdge {
  return { id: e.id, from: e.from, to: e.to, verb: e.verb, label: `${e.verb} ${e.label}`, count: e.count, sites: e.sites, confidence: e.confidence };
}

/** The subtitle of a component card: its role, and its route count when it serves any. */
function subOf(n: TierNode): string {
  const role = n.role !== undefined ? ROLE_TEXT[n.role] : "Unit";
  return n.routes > 0 ? `${role} · ${plural(n.routes, "route")}` : role;
}

/**
 * The System-shaped model of a Tiers model, and its layout options. Frontend and backend units are the two component columns;
 * stores and services are drawn in a Storage column and an External column. A platform is a note on the card ("Vercel Function").
 */
export function tierSystem(t: TierModel): TierSystem {
  const deployable = t.nodes.filter((n) => n.tier === "frontend" || n.tier === "backend");
  const outside = t.nodes.filter((n) => n.tier === "storage" || n.tier === "external");
  const ids = (tier: TierNode["tier"]): string[] => deployable.filter((n) => n.tier === tier).map((n) => n.id);
  const notes = new Map<string, string>();
  const subs = new Map<string, string>();
  for (const n of deployable) {
    if (n.platform !== undefined) notes.set(n.id, PLATFORM_TEXT[n.platform]);
    subs.set(n.id, subOf(n));
  }
  const sys: SystemModel = {
    scope: t.scope,
    runtime: "none",
    components: deployable.map(componentOf),
    routes: [],
    externals: outside.map(externalOf),
    edges: t.edges.map(edgeOf),
    stages: [ids("frontend"), ids("backend")],
  };
  return {
    sys,
    layout: {
      titles: ["Frontend", "Backend"],
      notes,
      subs,
      keepStages: true,
      externalColumns: [
        { title: "Storage", categories: ["store", "filesystem"] },
        { title: "External", categories: ["service", "worker"] },
      ],
    },
  };
}
