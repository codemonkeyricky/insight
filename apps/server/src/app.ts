import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { ProjectError, ProjectRegistry, insightHome, type ProjectRecord } from "./registry.js";
import { JobRunner, type IndexFn, type JobEvent } from "./jobs.js";
import { allFindings, analysisFor, lensRecord, nodeFacts, overview, publicProject, resolveSnapshot } from "./reader.js";
import { sourceSlice } from "./source.js";

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

export async function buildServer(opts: ServerOptions = {}): Promise<InsightServer> {
  const home = opts.home ? resolve(opts.home) : insightHome();
  const registry = new ProjectRegistry(home);
  const jobs = new JobRunner({ registry, intervalMs: opts.intervalMs, index: opts.index });
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ProjectError) {
      return reply.code(err.statusCode).send({ error: err.message });
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
    // A clone is ours to delete. A local folder is the user's, and only its .insight folder is ours, which stays.
    if (p.source.kind === "git") rmSync(p.source.checkout, { recursive: true, force: true });
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
    return overview(p, jobs, rootFor(p), req.query.snapshot);
  });

  app.get<{ Params: ProjectParams; Querystring: SnapshotQuery }>("/api/projects/:id/lenses", async (req) => {
    const p = project(req.params.id);
    const snapshot = resolveSnapshot(rootFor(p), req.query.snapshot);
    const analysis = analysisFor(rootFor(p), snapshot);
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
      const snapshot = resolveSnapshot(rootFor(p), req.query.snapshot);
      return { snapshot: snapshot ?? null, lens: lensRecord(rootFor(p), snapshot, req.params.lensId) };
    },
  );

  app.get<{ Params: ProjectParams; Querystring: SnapshotQuery & { lens?: string; severity?: string } }>(
    "/api/projects/:id/findings",
    async (req) => {
      const p = project(req.params.id);
      const snapshot = resolveSnapshot(rootFor(p), req.query.snapshot);
      if (!snapshot) return { snapshot: null, findings: [] };
      const { lens, severity } = req.query;
      const findings = allFindings(rootFor(p), snapshot).filter(
        (f) => (lens === undefined || f.lens === lens) && (severity === undefined || f.severity === severity),
      );
      return { snapshot, findings };
    },
  );

  app.get<{ Params: ProjectParams & { "*": string }; Querystring: SnapshotQuery }>(
    "/api/projects/:id/nodes/*",
    async (req) => {
      const p = project(req.params.id);
      const snapshot = resolveSnapshot(rootFor(p), req.query.snapshot);
      if (!snapshot) throw new ProjectError(404, "project has no snapshot yet");
      return { snapshot, ...nodeFacts(rootFor(p), snapshot, req.params["*"]) };
    },
  );

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
    },
  };
}

