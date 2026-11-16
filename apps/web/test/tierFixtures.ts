import type { TierEdge, TierModel, TierNode } from "@insight/model";

// A hand-made Tiers model: a browser app, a server and a Vercel function, a SQLite store, the local disk and a GitHub API.
export const WEB = "apps/web";
export const API = "apps/api";
export const FN = "apps/fn";
export const SQLITE = "store:sqlite";
export const DISK = "fs";
export const GH = "svc:github-api";

const unit = (over: Partial<TierNode> & Pick<TierNode, "id" | "label" | "tier">): TierNode => ({ routes: 0, libraries: [], signals: [], ...over });

export const tierNodes: TierNode[] = [
  unit({ id: WEB, label: "web", tier: "frontend", role: "spa", platform: "browser", component: WEB, path: WEB }),
  unit({ id: API, label: "api", tier: "backend", role: "server", platform: "node", component: API, path: API, routes: 2 }),
  unit({ id: FN, label: "fn", tier: "backend", role: "function", platform: "vercel", component: FN, path: FN, routes: 1 }),
  unit({ id: SQLITE, label: "SQLite", tier: "storage", external: { id: SQLITE, label: "SQLite", category: "store" } }),
  unit({ id: DISK, label: "Local disk", tier: "storage", external: { id: DISK, label: "fs", category: "filesystem" } }),
  unit({ id: GH, label: "GitHub API", tier: "external", external: { id: GH, label: "GitHub API", category: "service", host: "api.github.com" } }),
];

const edge = (over: Partial<TierEdge> & Pick<TierEdge, "id" | "from" | "to" | "verb" | "label">): TierEdge => ({ count: 1, sites: [], confidence: "exact", apis: [], ...over });

export const tierEdges: TierEdge[] = [
  edge({ id: `${WEB}>requests>${API}`, from: WEB, to: API, verb: "requests", label: "GET /api/items" }),
  edge({ id: `${WEB}>requests>${FN}`, from: WEB, to: FN, verb: "requests", label: "POST /api/index" }),
  edge({ id: `${API}>opens>${SQLITE}`, from: API, to: SQLITE, verb: "opens", label: "better-sqlite3" }),
  edge({ id: `${WEB}>reads>${DISK}`, from: WEB, to: DISK, verb: "reads", label: "assets" }),
  edge({ id: `${FN}>reads>${GH}`, from: FN, to: GH, verb: "reads", label: "GET", confidence: "inferred", via: ["packages/lib"] }),
];

export function tierFixture(over: Partial<TierModel> = {}): TierModel {
  const nodes = over.nodes ?? tierNodes;
  const columns = (["frontend", "backend", "storage", "external"] as const).map((tier) => ({
    tier,
    title: { frontend: "Frontend", backend: "Backend", storage: "Storage", external: "External" }[tier],
    nodes: nodes.filter((n) => n.tier === tier).map((n) => n.id),
  }));
  return { scope: "", columns, nodes, edges: over.edges ?? tierEdges, hidden: { libraries: [], unmatchedApi: 0, dev: 0 }, ...over };
}
