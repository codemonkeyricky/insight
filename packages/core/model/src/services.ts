// The catalog of outside services the System view names. A request's host is matched exactly, or by suffix (a
// leading "*." pattern written as ".suffix"). Some hosts split by path: a Cloudflare API call under /storage/kv/ is
// the KV store, not the generic API.
import type { SystemExternal } from "./system.js";

/** A service a host belongs to. `paths` refines it: the first rule whose `includes` is in the request path wins. */
export interface ServiceEntry {
  /** The stable external id, used as the external's id in the System model. */
  id: string;
  label: string;
  category: SystemExternal["category"];
  /** Matches the host exactly, or as a suffix when the entry starts with ".". */
  host: string;
  paths?: Array<{ includes: string; id: string; label: string; category: SystemExternal["category"] }>;
}

/** The known hosts. Order matters only for suffix overlaps; each host matches one entry. */
export const SERVICES: readonly ServiceEntry[] = [
  { id: "svc:github-api", label: "GitHub API", category: "service", host: "api.github.com" },
  { id: "svc:github-codeload", label: "GitHub codeload", category: "service", host: "codeload.github.com" },
  { id: "svc:github-raw", label: "GitHub raw", category: "service", host: "raw.githubusercontent.com" },
  {
    id: "svc:cloudflare-api",
    label: "Cloudflare API",
    category: "service",
    host: "api.cloudflare.com",
    paths: [
      { includes: "/storage/kv/", id: "svc:cloudflare-kv", label: "Cloudflare KV", category: "store" },
      { includes: "/r2/", id: "svc:cloudflare-r2", label: "Cloudflare R2", category: "store" },
    ],
  },
  { id: "svc:cloudflare-r2", label: "Cloudflare R2", category: "store", host: ".r2.cloudflarestorage.com" },
  { id: "svc:cloudflare-worker", label: "Cloudflare Worker", category: "worker", host: ".workers.dev" },
  { id: "svc:vercel-api", label: "Vercel API", category: "service", host: "api.vercel.com" },
  { id: "svc:npm-registry", label: "npm registry", category: "service", host: "registry.npmjs.org" },
];

/** The external a host (and optionally a request path) stands for. Unknown hosts are their own service, named by the host. */
export function classifyHost(host: string, path = ""): { id: string; label: string; category: SystemExternal["category"]; host: string } {
  const bare = host.toLowerCase();
  for (const entry of SERVICES) {
    const hit = entry.host.startsWith(".") ? bare.endsWith(entry.host) : bare === entry.host;
    if (!hit) continue;
    const rule = entry.paths?.find((p) => path.includes(p.includes));
    if (rule) return { id: rule.id, label: rule.label, category: rule.category, host: bare };
    return { id: entry.id, label: entry.label, category: entry.category, host: bare };
  }
  return { id: `host:${bare}`, label: bare, category: "service", host: bare };
}

/** A store a database driver opens: its external id in the System model and its label. */
export interface StoreDriver {
  id: string;
  label: string;
}

const STORE_DRIVER_LIST: ReadonlyArray<{ specifiers: readonly string[]; store: StoreDriver }> = [
  { specifiers: ["better-sqlite3", "sqlite3", "node:sqlite"], store: { id: "store:sqlite", label: "SQLite" } },
  { specifiers: ["pg"], store: { id: "store:postgresql", label: "PostgreSQL" } },
  { specifiers: ["mysql2"], store: { id: "store:mysql", label: "MySQL" } },
  { specifiers: ["mongodb"], store: { id: "store:mongodb", label: "MongoDB" } },
  { specifiers: ["redis", "ioredis"], store: { id: "store:redis", label: "Redis" } },
  { specifiers: ["@vercel/kv"], store: { id: "store:vercel-kv", label: "Vercel KV" } },
  { specifiers: ["@vercel/blob"], store: { id: "store:vercel-blob", label: "Vercel Blob" } },
  { specifiers: ["@aws-sdk/client-s3"], store: { id: "store:s3", label: "S3" } },
];

/** The import specifiers that open a store, by the package they import. A subpath of one (`pg/lib/x`) counts too. */
export const STORE_DRIVERS: ReadonlyMap<string, StoreDriver> = new Map(STORE_DRIVER_LIST.flatMap((d) => d.specifiers.map((s) => [s, d.store] as const)));

/** The store an import specifier opens, or undefined when it is not a database driver. */
export function storeDriverOf(specifier: string): StoreDriver | undefined {
  const exact = STORE_DRIVERS.get(specifier);
  if (exact !== undefined) return exact;
  const slash = specifier.indexOf("/", specifier.startsWith("@") ? specifier.indexOf("/") + 1 : 0);
  return slash === -1 ? undefined : STORE_DRIVERS.get(specifier.slice(0, slash));
}
