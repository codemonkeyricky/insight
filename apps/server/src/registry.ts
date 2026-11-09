import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { STATE_DIR, type CoverageRow } from "@insight/core";

export type ProjectSource = { kind: "path"; path: string } | { kind: "git"; url: string; checkout: string };

export interface LastRun {
  snapshot: string;
  commit?: string;
  /** True when the working tree had uncommitted changes, so the snapshot is not exactly the commit. */
  dirty?: boolean;
  finishedAt: string;
  durationMs: number;
  nodes: number;
  edges: number;
  findings: number;
  extracted: number;
  reused: number;
  coverage: CoverageRow[];
  problems: string[];
  lenses: LensSummary[];
}

export interface LensSummary {
  id: string;
  title: string;
  status: "ok" | "unavailable" | "error";
  reason?: string;
  reused: boolean;
  findings: number;
}

export interface ProjectRecord {
  id: string;
  name: string;
  addedAt: string;
  source: ProjectSource;
  /** Where the generated state lives. See chooseStateDir. */
  stateDir: string;
  allowBuildTools: boolean;
  status: "idle" | "indexing" | "error";
  error?: string;
  last?: LastRun;
}

interface RegistryFile {
  schema: 1;
  projects: ProjectRecord[];
}

/** The folder that holds the registry and git clones. INSIGHT_HOME overrides the default. */
export function insightHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.INSIGHT_HOME ?? join(homedir(), ".insight"));
}

/**
 * Where a project's generated state goes. A local folder that already has an index in its own `.insight` folder keeps
 * it there, so an existing project is not re-indexed from scratch. Every other project keeps its state under
 * `<home>/projects/<id>`, which leaves the user's folder clean.
 */
export function chooseStateDir(home: string, id: string, source: ProjectSource, exists: (file: string) => boolean = existsSync): string {
  if (source.kind === "path" && exists(join(source.path, STATE_DIR, "index.sqlite"))) return join(source.path, STATE_DIR);
  return join(home, "projects", id);
}

/** True when the state folder is one the server made under its home. Only these are ever deleted with a project. */
export function ownsStateDir(home: string, stateDir: string): boolean {
  const owned = join(home, "projects") + sep;
  return stateDir.startsWith(owned);
}

/** Projects on disk, in insight home/projects.json. Writes are atomic. */
export class ProjectRegistry {
  private readonly file: string;
  private projects: ProjectRecord[];

  constructor(readonly home: string) {
    mkdirSync(home, { recursive: true });
    this.file = join(home, "projects.json");
    this.projects = existsSync(this.file)
      ? (JSON.parse(readFileSync(this.file, "utf8")) as RegistryFile).projects
      : [];
    // Records written before stateDir existed get one now. The choice is saved, so it does not change later.
    let migrated = false;
    for (const p of this.projects) {
      if (p.stateDir === undefined) {
        p.stateDir = chooseStateDir(home, p.id, p.source);
        migrated = true;
      }
    }
    if (migrated) this.save();
  }

  /** The folder the generated state of a project is kept in. */
  stateOf(p: ProjectRecord): string {
    return p.stateDir;
  }

  list(): ProjectRecord[] {
    return this.projects.map((p) => structuredClone(p));
  }

  get(id: string): ProjectRecord | undefined {
    const p = this.projects.find((x) => x.id === id);
    return p ? structuredClone(p) : undefined;
  }

  /** The folder that is indexed: the path itself, or the git clone. */
  rootOf(p: ProjectRecord): string {
    return p.source.kind === "path" ? p.source.path : p.source.checkout;
  }

  add(input: { name?: string; path?: string; url?: string; allowBuildTools?: boolean }): ProjectRecord {
    if ((input.path === undefined) === (input.url === undefined)) {
      throw new ProjectError(400, "give exactly one of path or url");
    }
    const id = randomUUID().slice(0, 8);
    let source: ProjectSource;
    if (input.path !== undefined) {
      const abs = resolve(input.path);
      if (!existsSync(abs)) throw new ProjectError(400, `path does not exist: ${abs}`);
      if (this.projects.some((p) => p.source.kind === "path" && p.source.path === abs)) {
        throw new ProjectError(409, `${abs} is already a project`);
      }
      source = { kind: "path", path: abs };
    } else {
      const url = (input.url ?? "").trim();
      if (!/^(https?:\/\/|git@|ssh:\/\/|git:\/\/|file:\/\/)/.test(url)) {
        throw new ProjectError(400, "url must be an http, https, ssh or git URL");
      }
      if (this.projects.some((p) => p.source.kind === "git" && p.source.url === url)) {
        throw new ProjectError(409, `${url} is already a project`);
      }
      source = { kind: "git", url, checkout: join(this.home, "clones", id) };
    }
    const name = (input.name ?? "").trim() || basename(source.kind === "path" ? source.path : source.url.replace(/\.git$/, ""));
    const record: ProjectRecord = {
      id,
      name,
      addedAt: new Date().toISOString(),
      source,
      stateDir: chooseStateDir(this.home, id, source),
      allowBuildTools: input.allowBuildTools === true,
      status: "idle",
    };
    this.projects.push(record);
    this.save();
    return structuredClone(record);
  }

  remove(id: string): boolean {
    const before = this.projects.length;
    this.projects = this.projects.filter((p) => p.id !== id);
    if (this.projects.length === before) return false;
    this.save();
    return true;
  }

  update(id: string, patch: Partial<Omit<ProjectRecord, "id">>): ProjectRecord | undefined {
    const p = this.projects.find((x) => x.id === id);
    if (!p) return undefined;
    Object.assign(p, patch);
    this.save();
    return structuredClone(p);
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ schema: 1, projects: this.projects } satisfies RegistryFile, null, 2));
    renameSync(tmp, this.file);
  }
}

export class ProjectError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}
