import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { ProjectError, ProjectRegistry, insightHome, ownsStateDir, type ProjectRecord } from "./registry.js";
import { JobRunner, type IndexFn, type JobEvent } from "./jobs.js";
import {
  addAnnotation,
  checklist,
  clearDecision,
  compareCommits,
  deleteAnnotation,
  InputError,
  keyedFindings,
  listAnnotations,
  projectPaths,
  readReview,
  setDecision,
  updateAnnotation,
} from "@insight/core";
import type { ProjectRoot } from "@insight/sdk";
import {
  allFindings,
  analysisFor,
  fileFacts,
  fileFlow,
  flowSummary,
  languageOf,
  lensRecord,
  listFiles,
  nodeFacts,
  overview,
  publicProject,
  resolveSnapshot,
  runScopedLens,
  scopeArchOf,
  scopeExecLayoutOf,
  scopeExecOf,
  scopeFlowOf,
  scopeLensRows,
  scopeView,
  serializedModelOf,
} from "./reader.js";
import { readFileText, sourceSlice } from "./source.js";
import { closeExecLayoutWorker } from "./exec-layout.js";

export const SERVER_VERSION = "0.1.0";
const HERE = dirname(fileURLToPath(import.meta.url));
/** The web app build, relative to the compiled server: apps/server/dist -> apps/web/dist. */
export const DEFAULT_WEB_DIST = resolve(HERE, "..", "..", "web", "dist");

export interface ServerOptions {
  /** Registry and clone folder. Defaults to INSIGHT_HOME or ~/.insight. */
  home?: string;
  /** Re-index interval. Zero disables it. Defaults to five minutes. */
  intervalMs?: number;
  /** Replaces the indexer. Used by tests. */
  index?: IndexFn;
  /** Folder with the built web app. Pass null to serve the API only. */
  webDist?: string | null;
  /** Start the schedule and index every project on startup. Defaults to true. */
  autostart?: boolean;
}

export interface InsightServer {
  app: FastifyInstance;
  registry: ProjectRegistry;
  jobs: JobRunner;
  close(): Promise<void>;
}

interface ProjectParams {
  id: string;
}

interface SnapshotQuery {
  snapshot?: string;
}

/** The `path` query of a scope route. It must be given, once. An empty string is the project scope. */
function scopePathOf(raw: unknown): string {
  if (raw === undefined) throw new ProjectError(400, "path is required");
  if (typeof raw !== "string") throw new ProjectError(400, "path must be given once");
  return raw;
}

export async function buildServer(opts: ServerOptions = {}): Promise<InsightServer> {
  const home = opts.home ? resolve(opts.home) : insightHome();
  const registry = new ProjectRegistry(home);
  const jobs = new JobRunner({ registry, intervalMs: opts.intervalMs, index: opts.index });
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ProjectError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    if (err instanceof InputError) {
      return reply.code(400).send({ error: err.message });
    }
    const e = err as { statusCode?: number; message: string };
    if (e.statusCode !== undefined && e.statusCode < 500) {
      return reply.code(e.statusCode).send({ error: e.message });
    }
    app.log.error(err);
    return reply.code(500).send({ error: "internal error" });
  });

  const project = (id: string): ProjectRecord => {
    const p = registry.get(id);
    if (!p) throw new ProjectError(404, `no project ${id}`);
    return p;
  };
  const rootFor = (p: ProjectRecord): string => registry.rootOf(p);
  /** The project's folder and its state folder. Reads of the index take this. */
  const pathsFor = (p: ProjectRecord) => projectPaths(rootFor(p), registry.stateOf(p));
  const projectRoot = (p: ProjectRecord): ProjectRoot => ({ path: rootFor(p), name: p.name, allowBuildTools: p.allowBuildTools });

  app.get("/api/health", async () => ({ ok: true, version: SERVER_VERSION, home }));

  app.get("/api/projects", async () => ({ projects: registry.list().map((p) => publicProject(p, jobs)) }));

  app.post<{ Body: { path?: string; url?: string; name?: string; allowBuildTools?: boolean; index?: boolean } }>(
    "/api/projects",
    async (req, reply) => {
      const body = req.body ?? {};
      const record = registry.add({
        path: typeof body.path === "string" ? body.path : undefined,
        url: typeof body.url === "string" ? body.url : undefined,
        name: typeof body.name === "string" ? body.name : undefined,
        allowBuildTools: body.allowBuildTools === true,
      });
      if (body.index !== false) jobs.trigger(record.id);
      return reply.code(201).send({ project: publicProject(project(record.id), jobs) });
    },
  );

  app.get<{ Params: ProjectParams }>("/api/projects/:id", async (req) => ({
    project: publicProject(project(req.params.id), jobs),
  }));

  app.delete<{ Params: ProjectParams }>("/api/projects/:id", async (req, reply) => {
    const p = project(req.params.id);
    if (jobs.isIndexing(p.id)) throw new ProjectError(409, "project is indexing; try again when it finishes");
    registry.remove(p.id);
    // A clone is ours to delete. A local folder is the user's and is never touched. The state folder goes only when the
    // server made it under its home; a legacy state folder inside the user's folder stays.
    if (p.source.kind === "git") rmSync(p.source.checkout, { recursive: true, force: true });
    if (ownsStateDir(registry.home, p.stateDir)) rmSync(p.stateDir, { recursive: true, force: true });
    return reply.code(204).send();
  });

  app.post<{ Params: ProjectParams; Body: { full?: boolean } }>("/api/projects/:id/reindex", async (req, reply) => {
    const p = project(req.params.id);
    const result = jobs.trigger(p.id, { full: req.body?.full === true });
    return reply.code(202).send({ result, project: publicProject(project(p.id), jobs) });
  });

  app.get<{ Params: ProjectParams }>("/api/projects/:id/events", async (req, reply) => {
    const p = project(req.params.id);
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (event: JobEvent) => {
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const current = project(p.id);
    send({
      type: "status",
      projectId: p.id,
      status: jobs.isIndexing(p.id) ? "indexing" : current.status,
      queued: jobs.isQueued(p.id),
      at: new Date().toISOString(),
      ...(current.error ? { error: current.error } : {}),
    });
    const unsubscribe = jobs.subscribe(p.id, send);
    const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 15_000);
    heartbeat.unref();
    req.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    return;
  });

  app.get<{ Params: ProjectParams; Querystring: SnapshotQuery }>("/api/projects/:id/overview", async (req) => {
    const p = project(req.params.id);
    return overview(p, jobs, pathsFor(p), req.query.snapshot);
  });

  app.get<{ Params: ProjectParams; Querystring: SnapshotQuery }>("/api/projects/:id/lenses", async (req) => {
    const p = project(req.params.id);
    const snapshot = resolveSnapshot(pathsFor(p), req.query.snapshot);
    const analysis = analysisFor(pathsFor(p), snapshot);
    return {
      snapshot: snapshot ?? null,
      lenses: (analysis?.lenses ?? []).map(({ result: _result, ...rest }) => ({
        ...rest,
        findings: _result?.findings.length ?? 0,
        views: _result?.views.map((v) => ({ id: v.id, type: v.type, title: v.title })) ?? [],
      })),
    };
  });

  app.get<{ Params: ProjectParams & { lensId: string }; Querystring: SnapshotQuery }>(
    "/api/projects/:id/lenses/:lensId",
    async (req) => {
      const p = project(req.params.id);
      const snapshot = resolveSnapshot(pathsFor(p), req.query.snapshot);
      return { snapshot: snapshot ?? null, lens: lensRecord(pathsFor(p), snapshot, req.params.lensId) };
    },
  );

  // Scoped IR: a folder or file of the snapshot, with its own lens runs. See docs/scoped-ir.md.
  app.get<{ Params: ProjectParams; Querystring: SnapshotQuery & { path?: string } }>("/api/projects/:id/scope/lenses", async (req) => {
    const p = project(req.params.id);
    const path = scopePathOf(req.query.path);
    const snapshot = resolveSnapshot(pathsFor(p), req.query.snapshot);
    if (!snapshot) throw new ProjectError(404, "project has no snapshot yet");
    const view = await scopeView(pathsFor(p), snapshot, path);
    return {
      snapshot,
      scope: view.scope,
      kind: view.kind,
      stats: view.stats,
      facets: view.facets,
      lenses: scopeLensRows(view, pathsFor(p)),
    };
  });

  app.get<{ Params: ProjectParams & { lensId: string }; Querystring: SnapshotQuery & { path?: string } }>(
    "/api/projects/:id/scope/lenses/:lensId",
    async (req) => {
      const p = project(req.params.id);
      const path = scopePathOf(req.query.path);
      const snapshot = resolveSnapshot(pathsFor(p), req.query.snapshot);
      if (!snapshot) throw new ProjectError(404, "project has no snapshot yet");
      const view = await scopeView(pathsFor(p), snapshot, path);
      return { snapshot, scope: view.scope, kind: view.kind, lens: await runScopedLens(view, req.params.lensId, projectRoot(p), registry.stateOf(p)) };
    },
  );

  // The call flow of a scope: its functions, the calls between them, and the calls that cross its edge.
  app.get<{ Params: ProjectParams; Querystring: SnapshotQuery & { path?: string } }>("/api/projects/:id/scope/flow", async (req) => {
    const p = project(req.params.id);
    const path = scopePathOf(req.query.path);
    const snapshot = resolveSnapshot(pathsFor(p), req.query.snapshot);
    if (!snapshot) throw new ProjectError(404, "project has no snapshot yet");
    const { scope, kind, flow } = scopeFlowOf(pathsFor(p), snapshot, path);
    return { snapshot, scope, kind, ...flow };
  });

  // The execution model of a scope: its threads, the functions each runs, and the coroutines it awaits.
  // Same errors as the flow route, which it shares its path and snapshot checks with.
  app.get<{ Params: ProjectParams; Querystring: SnapshotQuery & { path?: string } }>("/api/projects/:id/scope/exec", async (req) => {
    const p = project(req.params.id);
    const path = scopePathOf(req.query.path);
    const snapshot = resolveSnapshot(pathsFor(p), req.query.snapshot);
    if (!snapshot) throw new ProjectError(404, "project has no snapshot yet");
    // exec.scope is the normalized scope, so the spread supplies it. Naming it again would be overwritten.
    const { kind, exec } = scopeExecOf(pathsFor(p), snapshot, path);
    return { snapshot, kind, ...exec };
  });

  // The exec scene of a scope, laid out whole on the server so the page does not solve it in its worker. Same path,
  // snapshot and errors as the exec route. The answer is the layout's containers, which the page checks against the scene.
  app.get<{ Params: ProjectParams; Querystring: SnapshotQuery & { path?: string } }>("/api/projects/:id/scope/exec-layout", async (req) => {
    const p = project(req.params.id);
    const path = scopePathOf(req.query.path);
    const snapshot = resolveSnapshot(pathsFor(p), req.query.snapshot);
    if (!snapshot) throw new ProjectError(404, "project has no snapshot yet");
    const { kind, layout } = await scopeExecLayoutOf(pathsFor(p), snapshot, path);
    return { snapshot, kind, ...layout };
  });

  // The package-level architecture: packages by layer, the imports between them, unresolved imports and rule violations.
  // The model covers the whole snapshot, so the scope gives only the path check. Same path, snapshot and errors as the exec route.
  app.get<{ Params: ProjectParams; Querystring: SnapshotQuery & { path?: string } }>("/api/projects/:id/scope/arch", async (req) => {
    const p = project(req.params.id);
    const path = scopePathOf(req.query.path);
    const snapshot = resolveSnapshot(pathsFor(p), req.query.snapshot);
    if (!snapshot) throw new ProjectError(404, "project has no snapshot yet");
    const { scope, kind, arch } = scopeArchOf(pathsFor(p), snapshot, path);
    return { snapshot, scope, kind, ...arch };
  });

  // The whole-project model of a snapshot, serialized once per request. The browser builds its scope views from it,
  // so the scope routes above stay for other clients. Same snapshot and errors as the scope routes.
  app.get<{ Params: ProjectParams; Querystring: SnapshotQuery }>("/api/projects/:id/model", async (req) => {
    const p = project(req.params.id);
    const snapshot = resolveSnapshot(pathsFor(p), req.query.snapshot);
    if (!snapshot) throw new ProjectError(404, "project has no snapshot yet");
    return serializedModelOf(pathsFor(p), snapshot);
  });

  app.get<{ Params: ProjectParams; Querystring: SnapshotQuery & { lens?: string; severity?: string } }>(
    "/api/projects/:id/findings",
    async (req) => {
      const p = project(req.params.id);
      const snapshot = resolveSnapshot(pathsFor(p), req.query.snapshot);
      if (!snapshot) return { snapshot: null, findings: [] };
      const { lens, severity } = req.query;
      const findings = allFindings(pathsFor(p), snapshot).filter(
        (f) => (lens === undefined || f.lens === lens) && (severity === undefined || f.severity === severity),
      );
      return { snapshot, findings };
    },
  );

  app.get<{ Params: ProjectParams & { "*": string }; Querystring: SnapshotQuery }>(
    "/api/projects/:id/nodes/*",
    async (req) => {
      const p = project(req.params.id);
      const snapshot = resolveSnapshot(pathsFor(p), req.query.snapshot);
      if (!snapshot) throw new ProjectError(404, "project has no snapshot yet");
      return { snapshot, ...nodeFacts(pathsFor(p), snapshot, req.params["*"]) };
    },
  );

  app.get<{ Params: ProjectParams; Querystring: SnapshotQuery }>("/api/projects/:id/files", async (req) => {
    const p = project(req.params.id);
    const snapshot = resolveSnapshot(pathsFor(p), req.query.snapshot);
    return { snapshot: snapshot ?? null, files: snapshot ? listFiles(pathsFor(p), snapshot) : [] };
  });

  app.get<{ Params: ProjectParams; Querystring: SnapshotQuery & { path?: string } }>("/api/projects/:id/file", async (req) => {
    const p = project(req.params.id);
    const path = req.query.path;
    if (!path) throw new ProjectError(400, "path is required");
    const text = readFileText(rootFor(p), path);
    const snapshot = resolveSnapshot(pathsFor(p), req.query.snapshot);
    const facts = snapshot ? fileFacts(pathsFor(p), snapshot, path) : { symbols: [], findings: [] };
    const language = languageOf(path);
    return { snapshot: snapshot ?? null, ...text, ...(language ? { language } : {}), ...facts };
  });

  app.get<{ Params: ProjectParams; Querystring: SnapshotQuery & { path?: string } }>("/api/projects/:id/flow", async (req) => {
    const p = project(req.params.id);
    const path = req.query.path;
    if (!path) throw new ProjectError(400, "path is required");
    const snapshot = resolveSnapshot(pathsFor(p), req.query.snapshot);
    if (!snapshot) throw new ProjectError(404, "project has no snapshot yet");
    return { snapshot, ...fileFlow(pathsFor(p), snapshot, path) };
  });

  app.get<{ Params: ProjectParams; Querystring: SnapshotQuery }>("/api/projects/:id/flow-summary", async (req) => {
    const p = project(req.params.id);
    const snapshot = resolveSnapshot(pathsFor(p), req.query.snapshot);
    return { snapshot: snapshot ?? null, files: snapshot ? flowSummary(pathsFor(p), snapshot) : [] };
  });

  app.get<{ Params: ProjectParams; Querystring: { file?: string; start?: string; end?: string; context?: string } }>(
    "/api/projects/:id/source",
    async (req) => {
      const p = project(req.params.id);
      const { file, start, end, context } = req.query;
      if (!file) throw new ProjectError(400, "file is required");
      const first = Number(start ?? 1);
      const last = Number(end ?? first);
      if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < 1) {
        throw new ProjectError(400, "start and end must be line numbers from 1");
      }
      return sourceSlice(rootFor(p), file, first, last, Math.min(200, Number(context ?? 3) || 0));
    },
  );

  // Compare runs index commits into the project's own state folder. Two requests for one project run one at a time.
  const comparing = new Map<string, Promise<unknown>>();
  const serialized = <T>(projectId: string, work: () => Promise<T>): Promise<T> => {
    const prev = comparing.get(projectId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(work);
    comparing.set(projectId, next);
    next.catch(() => undefined).then(() => {
      if (comparing.get(projectId) === next) comparing.delete(projectId);
    });
    return next;
  };

  app.get<{ Params: ProjectParams; Querystring: { base?: string; head?: string } }>("/api/projects/:id/compare", async (req) => {
    const p = project(req.params.id);
    const { base, head } = req.query;
    if (!base || !head) throw new ProjectError(400, "base and head are required");
    const result = await serialized(p.id, () =>
      compareCommits(rootFor(p), base, head, { allowBuildTools: p.allowBuildTools, stateDir: registry.stateOf(p) }),
    );
    const side = (s: { commit: string; snapshot: string; reused: boolean }) => ({ commit: s.commit, snapshot: s.snapshot, reused: s.reused });
    return { base: side(result.base), head: side(result.head), diff: result.diff };
  });

  app.get<{ Params: ProjectParams; Querystring: { type?: string; key?: string } }>("/api/projects/:id/annotations", async (req) => {
    const p = project(req.params.id);
    return { annotations: listAnnotations(pathsFor(p), req.query) };
  });

  app.post<{ Params: ProjectParams; Body: Record<string, unknown> }>("/api/projects/:id/annotations", async (req, reply) => {
    const p = project(req.params.id);
    const body = req.body ?? {};
    const annotation = addAnnotation(pathsFor(p), { type: body.type, key: body.key, text: body.text });
    return reply.code(201).send({ annotation });
  });

  app.patch<{ Params: ProjectParams & { annId: string }; Body: Record<string, unknown> }>(
    "/api/projects/:id/annotations/:annId",
    async (req) => {
      const p = project(req.params.id);
      const annotation = updateAnnotation(pathsFor(p), req.params.annId, req.body?.text);
      if (!annotation) throw new ProjectError(404, `no annotation ${req.params.annId}`);
      return { annotation };
    },
  );

  app.delete<{ Params: ProjectParams & { annId: string } }>("/api/projects/:id/annotations/:annId", async (req, reply) => {
    const p = project(req.params.id);
    if (!deleteAnnotation(pathsFor(p), req.params.annId)) throw new ProjectError(404, `no annotation ${req.params.annId}`);
    return reply.code(204).send();
  });

  app.get<{ Params: ProjectParams; Querystring: SnapshotQuery }>("/api/projects/:id/review", async (req) => {
    const p = project(req.params.id);
    const paths = pathsFor(p);
    const snapshot = resolveSnapshot(paths, req.query.snapshot);
    const findings = snapshot ? keyedFindings(analysisFor(paths, snapshot)) : [];
    return { snapshot: snapshot ?? null, ...checklist(findings, readReview(paths)) };
  });

  app.put<{ Params: ProjectParams; Body: Record<string, unknown> }>("/api/projects/:id/review", async (req) => {
    const p = project(req.params.id);
    const body = req.body ?? {};
    const decision = setDecision(pathsFor(p), body.key, body.status, body.note);
    return { key: String(body.key), decision };
  });

  app.delete<{ Params: ProjectParams; Querystring: { key?: string } }>("/api/projects/:id/review", async (req, reply) => {
    const p = project(req.params.id);
    const key = req.query.key;
    if (typeof key !== "string" || key.trim() === "") throw new ProjectError(400, "key is required");
    clearDecision(pathsFor(p), key);
    return reply.code(204).send();
  });

  const webDist = opts.webDist === null ? undefined : (opts.webDist ?? DEFAULT_WEB_DIST);
  const hasWeb = webDist !== undefined && existsSync(join(webDist, "index.html"));
  if (webDist && hasWeb) {
    // The static plugin serves real files. Anything else that is not an API route gets the app shell.
    await app.register(fastifyStatic, { root: webDist, prefix: "/" });
  }
  app.setNotFoundHandler(async (req: FastifyRequest, reply: FastifyReply) => {
    const isApi = req.url.startsWith("/api/");
    if (hasWeb && req.method === "GET" && !isApi) return reply.type("text/html").sendFile("index.html");
    return reply.code(404).send({ error: `not found: ${req.method} ${req.url}` });
  });

  if (opts.autostart !== false) jobs.start();

  return {
    app,
    registry,
    jobs,
    close: async () => {
      jobs.stop();
      await app.close();
      await closeExecLayoutWorker();
    },
  };
}

