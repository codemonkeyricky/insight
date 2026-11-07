import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createCoreRegistry, KindRegistry } from "@insight/ir";
import type { Frontend, Lens, Resolver } from "@insight/sdk";
import { checkManifest, type PluginManifest } from "./manifest.js";
import { projectPaths, repoRoot } from "./paths.js";

export const MANIFEST_FILE = "insight-plugin.json";

export interface LoadedFrontend {
  manifest: PluginManifest;
  dir: string;
  frontend: Frontend;
}

export interface LoadedResolver {
  manifest: PluginManifest;
  dir: string;
  resolver: Resolver;
}

export interface LoadedLens {
  manifest: PluginManifest;
  dir: string;
  lens: Lens;
}

export interface DisabledPlugin {
  id: string;
  dir: string;
  reason: string;
}

export interface LoadedPlugins {
  frontends: LoadedFrontend[];
  resolvers: LoadedResolver[];
  lenses: LoadedLens[];
  registry: KindRegistry;
  disabled: DisabledPlugin[];
}

export interface LoadOptions {
  /** The project being indexed. Its .insight/plugins folder is scanned last. */
  projectPath: string;
  /** Repository root holding packages/ and plugins/. Found automatically when omitted. */
  builtinRoot?: string;
  /** Per-user plugin folder. Defaults to ~/.insight/plugins. */
  userPluginDir?: string;
  /** Extra folders to scan, after the built-in ones. Used by tests. */
  extraDirs?: string[];
}

interface Candidate {
  manifest: PluginManifest;
  dir: string;
}

/** Lists the plugin folders directly inside a directory. */
function childDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((p) => statSync(p).isDirectory())
    .sort();
}

function scanCandidates(opts: LoadOptions): { candidates: Candidate[]; disabled: DisabledPlugin[] } {
  const builtin = opts.builtinRoot ?? repoRoot();
  const dirs: string[] = [];
  if (builtin) {
    dirs.push(...childDirs(join(builtin, "packages")), ...childDirs(join(builtin, "plugins")));
  }
  dirs.push(...childDirs(opts.userPluginDir ?? join(homedir(), ".insight", "plugins")));
  dirs.push(...childDirs(projectPaths(opts.projectPath).localPlugins));
  for (const extra of opts.extraDirs ?? []) dirs.push(...childDirs(extra));

  const candidates: Candidate[] = [];
  const disabled: DisabledPlugin[] = [];
  const seen = new Map<string, string>();
  for (const dir of dirs) {
    const file = join(dir, MANIFEST_FILE);
    if (!existsSync(file)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    } catch (err) {
      disabled.push({ id: dir, dir, reason: `${MANIFEST_FILE} is not valid JSON: ${(err as Error).message}` });
      continue;
    }
    const checked = checkManifest(raw);
    if (!checked.ok) {
      const id = typeof (raw as { id?: unknown }).id === "string" ? (raw as { id: string }).id : dir;
      disabled.push({ id, dir, reason: checked.reason });
      continue;
    }
    const { manifest } = checked;
    const previous = seen.get(manifest.id);
    if (previous !== undefined) {
      disabled.push({ id: manifest.id, dir, reason: `a plugin with id "${manifest.id}" is already loaded from ${previous}` });
      continue;
    }
    seen.set(manifest.id, dir);
    candidates.push({ manifest, dir });
  }
  return { candidates, disabled };
}

async function importEntry(dir: string, entry: string): Promise<Record<string, unknown>> {
  const file = resolve(dir, entry);
  if (!existsSync(file)) throw new Error(`entry ${entry} does not exist`);
  return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
}

/**
 * Loads every plugin that can be loaded. A plugin that fails any check is disabled with a reason,
 * and the others keep working. Built-in and outside plugins go through the same path.
 */
export async function loadPlugins(opts: LoadOptions): Promise<LoadedPlugins> {
  const { candidates, disabled } = scanCandidates(opts);
  const alive = new Map<string, Candidate>(candidates.map((c) => [c.manifest.id, c]));
  const fail = (c: Candidate, reason: string) => {
    disabled.push({ id: c.manifest.id, dir: c.dir, reason });
    alive.delete(c.manifest.id);
  };

  // 1. Import the role modules and check their shape against the manifest.
  const frontends = new Map<string, LoadedFrontend>();
  const resolvers: LoadedResolver[] = [];
  const lenses: LoadedLens[] = [];
  const definitions = new Map<string, unknown[]>();
  for (const c of candidates) {
    const { manifest, dir } = c;
    try {
      if (manifest.kinds !== undefined) {
        const file = resolve(dir, manifest.kinds);
        if (!existsSync(file)) throw new Error(`kinds file ${manifest.kinds} does not exist`);
        const defs = JSON.parse(readFileSync(file, "utf8")) as unknown;
        if (!Array.isArray(defs)) throw new Error(`kinds file ${manifest.kinds} must hold an array`);
        definitions.set(manifest.id, [...defs]);
      }
      if (manifest.roles.frontend !== undefined) {
        const mod = await importEntry(dir, manifest.roles.frontend);
        const frontend = (mod.default ?? mod.frontend) as Frontend | undefined;
        if (!frontend || typeof frontend.extract !== "function" || typeof frontend.detect !== "function") {
          throw new Error(`${manifest.roles.frontend} must export a Frontend (default export)`);
        }
        if (frontend.id !== manifest.id) throw new Error(`frontend id "${frontend.id}" does not match manifest id "${manifest.id}"`);
        const declared = [...(manifest.provides ?? [])].sort().join(",");
        const actual = [...frontend.provides].sort().join(",");
        if (declared !== actual) {
          throw new Error(`manifest provides [${declared}] but the frontend declares [${actual}]`);
        }
        frontends.set(manifest.id, { manifest, dir, frontend });
        if (frontend.defines?.length) {
          definitions.set(manifest.id, [...(definitions.get(manifest.id) ?? []), ...frontend.defines]);
        }
      }
      if (manifest.roles.resolver !== undefined) {
        const mod = await importEntry(dir, manifest.roles.resolver.entry);
        const resolver = (mod.default ?? mod.resolver) as Resolver | undefined;
        if (!resolver || typeof resolver.resolve !== "function") {
          throw new Error(`${manifest.roles.resolver.entry} must export a Resolver (default export)`);
        }
        if (resolver.scheme !== manifest.roles.resolver.scheme) {
          throw new Error(`resolver scheme "${resolver.scheme}" does not match manifest scheme "${manifest.roles.resolver.scheme}"`);
        }
        resolvers.push({ manifest, dir, resolver: { ...resolver, priority: manifest.roles.resolver.priority } });
      }
      if (manifest.roles.lens !== undefined) {
        const mod = await importEntry(dir, manifest.roles.lens);
        const lens = (mod.default ?? mod.lens) as Lens | undefined;
        if (!lens || typeof lens.run !== "function") throw new Error(`${manifest.roles.lens} must export a Lens (default export)`);
        if (lens.id !== manifest.id) throw new Error(`lens id "${lens.id}" does not match manifest id "${manifest.id}"`);
        lenses.push({ manifest, dir, lens });
      }
    } catch (err) {
      fail(c, (err as Error).message);
    }
  }

  // 2. Dependencies: a plugin needs every plugin it names in dependsOn to be loaded.
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of [...alive.values()]) {
      const missing = (c.manifest.dependsOn ?? []).find((d) => !alive.has(d));
      if (missing !== undefined) {
        fail(c, `depends on plugin "${missing}", which is not installed or was disabled`);
        changed = true;
      }
    }
  }

  // 3. Kind definitions. A batch that extends a kind not loaded yet waits for the next pass.
  const registry = createCoreRegistry();
  const pending = [...alive.values()].filter((c) => definitions.has(c.manifest.id));
  const lastError = new Map<string, string>();
  let progress = true;
  while (progress && pending.length > 0) {
    progress = false;
    for (const c of [...pending]) {
      try {
        registry.add(definitions.get(c.manifest.id) ?? [], c.manifest.id);
        pending.splice(pending.indexOf(c), 1);
        progress = true;
      } catch (err) {
        lastError.set(c.manifest.id, (err as Error).message);
      }
    }
  }
  for (const c of pending) fail(c, `kind definitions rejected: ${lastError.get(c.manifest.id) ?? "unknown error"}`);

  const keep = <T extends { manifest: PluginManifest }>(list: T[]) => list.filter((x) => alive.has(x.manifest.id));
  return {
    frontends: orderByDependencies(keep([...frontends.values()])),
    resolvers: keep(resolvers).sort((a, b) => b.resolver.priority - a.resolver.priority || a.manifest.id.localeCompare(b.manifest.id)),
    lenses: keep(lenses),
    registry,
    disabled: disabled.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** Sorts by dependsOn first, then by id, so run order is stable. */
function orderByDependencies<T extends { manifest: PluginManifest }>(items: T[]): T[] {
  const byId = new Map(items.map((i) => [i.manifest.id, i]));
  const done = new Set<string>();
  const out: T[] = [];
  const visit = (item: T) => {
    if (done.has(item.manifest.id)) return;
    done.add(item.manifest.id);
    for (const dep of item.manifest.dependsOn ?? []) {
      const d = byId.get(dep);
      if (d) visit(d);
    }
    out.push(item);
  };
  for (const item of [...items].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))) visit(item);
  return out;
}
