// The slim static export of one indexed project: the JSON files the static web build reads, written from an
// in-process hosted index. It indexes with the same server routes the live app uses (buildServer + app.inject), so the
// files match what the server would answer. No sources, no per-scope flows, no non-root scopes.
import { basename } from "node:path";
import { IndexLimitError, projectPaths, runIndex, type IndexLimits } from "@insight/indexer";
import { buildServer, loadSnapshot, type IndexFn } from "@insight/server";
import { edgeTargets } from "@insight/sdk";

/** The scope key of the project root, as the web app writes it. */
const ROOT_KEY = "@root";

export interface PhaseEvent {
  phase: string;
  done?: number;
  total?: number;
}

export interface ExportOptions {
  /** The project folder to index. */
  root: string;
  /** The project's display name. Defaults to the folder name. */
  name?: string;
  /** The commit label written to meta.json. Defaults to the snapshot's commit, or "unknown". */
  commit?: string;
  /** The server's home folder. Its state (the snapshot) is kept here, so pass a scratch folder. */
  home: string;
  /** Called on each indexing phase change, and on counted progress within a phase. */
  onPhase?: (p: PhaseEvent) => void;
  /** Caps on what the run reads. Defaults to the hosted caps. */
  limits?: IndexLimits;
  /** The GitHub URL to show as the project's source. Without it the source is shown by name only. */
  url?: string;
}

export interface ExportMeta {
  capturedAt: string;
  commit: string;
  nodes: number;
  edges: number;
  files: number;
}

export interface ExportResult {
  /** Relative path (as the static build reads it) to JSON text. */
  files: Map<string, string>;
  meta: ExportMeta;
}

/** A failed export. `code` is "too_large" when a cap was passed, "index_failed" otherwise. */
export class ExportError extends Error {
  readonly code: "too_large" | "index_failed";

  constructor(code: "too_large" | "index_failed", message: string) {
    super(message);
    this.name = "ExportError";
    this.code = code;
  }
}

/** True when the lens listing row has a saved result: an ok lens with something to show. */
function resultHasContent(result: { findings: readonly unknown[]; views: readonly { type: string; nodes?: unknown[]; edges?: unknown[]; rows?: unknown[]; root?: unknown }[] }): boolean {
  return result.findings.length > 0 || result.views.some((view) => {
    if (view.type === "graph") return (view.nodes?.length ?? 0) > 0 || (view.edges?.length ?? 0) > 0;
    if (view.type === "table") return (view.rows?.length ?? 0) > 0;
    return view.root !== undefined;
  });
}

export async function exportProject(opts: ExportOptions): Promise<ExportResult> {
  // The run's own error keeps its class; the job runner keeps only the message.
  let runError: unknown;
  const index: IndexFn = async (o) => {
    try {
      return await runIndex(o);
    } catch (err) {
      runError = err;
      throw err;
    }
  };
  const name = opts.name ?? basename(opts.root);
  const server = await buildServer({
    home: opts.home,
    hosted: true,
    allowPaths: true,
    limits: opts.limits,
    intervalMs: 0,
    webDist: null,
    autostart: false,
    index,
  });
  try {
    const record = server.registry.add({ path: opts.root, name, allowBuildTools: false });
    const unsubscribe = server.jobs.subscribe(record.id, (event) => {
      if (event.type !== "phase") return;
      const { phase, done, total } = event.progress;
      opts.onPhase?.({ phase, done, total });
    });
    server.jobs.trigger(record.id, { full: true });
    await server.jobs.whenIdle(record.id);
    unsubscribe();

    if (runError instanceof IndexLimitError) throw new ExportError("too_large", runError.message);
    const failed = server.registry.get(record.id);
    if (runError !== undefined || failed?.status === "error") {
      const message = runError instanceof Error ? runError.message : (failed?.error ?? "indexing failed");
      throw new ExportError("index_failed", message);
    }

    const get = async (url: string): Promise<any> => {
      const res = await server.app.inject({ url });
      if (res.statusCode !== 200) throw new ExportError("index_failed", `${url} -> ${res.statusCode} ${res.body}`);
      return res.json();
    };
    const base = `/api/projects/${record.id}`;
    const { project } = await get(base);
    const overview = await get(`${base}/overview`);
    if (!overview.snapshot) throw new ExportError("index_failed", "indexing produced no snapshot");
    const snapshotId: string = overview.snapshot.id;
    const commit = opts.commit ?? overview.snapshot.commit ?? "unknown";

    // The project as the static build shows it: a GitHub source when given, otherwise the name, never the local folder.
    const shown = {
      ...project,
      source: opts.url ? { kind: "git", url: opts.url } : { kind: "path", path: name },
      status: "idle",
      queued: false,
      error: undefined,
    };
    overview.project = shown;
    overview.snapshots = overview.snapshots.filter((s: { id: string }) => s.id === snapshotId);

    const lenses: Record<string, unknown> = {};
    for (const l of overview.lenses) lenses[l.id] = (await get(`${base}/lenses/${encodeURIComponent(l.id)}`)).lens;
    const { findings } = await get(`${base}/findings`);
    const { files: fileList } = await get(`${base}/files`);
    const modelJson = await get(`${base}/model`);
    const flowSummary = await get(`${base}/flow-summary`);

    // The root scope's lens listing, with each ok lens's result saved only when it has something to show.
    const q = "?path=";
    const initial = await get(`${base}/scope/lenses${q}`);
    const runs = new Map<string, any>();
    for (const row of initial.lenses) runs.set(row.id, await get(`${base}/scope/lenses/${encodeURIComponent(row.id)}${q}`));
    const listing = await get(`${base}/scope/lenses${q}`);
    for (const row of listing.lenses) {
      const run = runs.get(row.id);
      if (row.status === "ok" && run) row.hasContent = resultHasContent(run.lens.result ?? { findings: [], views: [] });
    }
    const arch = await get(`${base}/scope/arch${q}`);

    // The graph: every node and edge of the snapshot, with the edges that point at each node.
    const paths = projectPaths(server.registry.rootOf(record), server.registry.stateOf(record));
    const snap = loadSnapshot(paths, snapshotId);
    const nodes = [...snap.nodes.values()];
    const incoming: Record<string, number[]> = {};
    snap.edges.forEach((e, i) => {
      for (const t of edgeTargets(e).nodes) (incoming[t] ??= []).push(i);
    });
    const graph = { snapshot: snapshotId, nodes, edges: snap.edges, incoming };

    const meta: ExportMeta = {
      capturedAt: new Date().toISOString(),
      commit,
      nodes: nodes.length,
      edges: snap.edges.length,
      files: fileList.length,
    };

    const files = new Map<string, string>();
    const put = (rel: string, value: unknown) => files.set(rel, JSON.stringify(value));
    put("project.json", { project: shown, overview });
    put("lenses.json", lenses);
    put("findings.json", findings);
    put("graph.json", graph);
    put("model.json", modelJson);
    put("files.json", fileList);
    put("flow-summary.json", flowSummary);
    put("meta.json", meta);
    put(`scope/${ROOT_KEY}/lenses.json`, listing);
    for (const row of listing.lenses) {
      const run = runs.get(row.id);
      if (row.status === "ok" && row.hasContent === true && run !== undefined) put(`scope/${ROOT_KEY}/${row.id}.json`, run);
    }
    put(`scope/${ROOT_KEY}/arch.json`, arch);

    return { files, meta };
  } finally {
    await server.close();
  }
}
