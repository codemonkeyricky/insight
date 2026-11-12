// The scope payloads the browser computes from the project model. Each function answers what the server's
// /scope/flow and /scope/exec routes answer (apps/server/src/reader.ts, scopeFlowOf and scopeExecOf): the same
// flow and exec functions run on the same scoped IR, so the payloads are equal. Pure, with no React and no
// browser globals: the demo capture (scripts/capture-demo.mjs) imports this file too.
import { execModel, summarizeScope, type ExecFunctionRef, type ExecModel, type ScopeFlow } from "@insight/flow";
import { pipelineModel, refsOf, scopeView, ScopeError, systemModel, type PipelineModel, type ProjectModel, type Refs, type ScopeKindName, type SystemModel } from "@insight/model";
// The extension is written so the capture script can load this file with Node's type stripping (see scripts/capture-demo.mjs).
import { ApiError } from "../apiError.ts";

/** The fields a route adds around a payload. */
export type ScopeFlowPayload = ScopeFlow & { snapshot: string; scope: string; kind: ScopeKindName };
export type ScopeExecPayload = ExecModel & { snapshot: string; kind: ScopeKindName };

/** Bounded like the server's per-scope caches. A model is per snapshot, so its payloads are too. */
const LIMIT = 32;
const memo = new WeakMap<ProjectModel, Map<string, unknown>>();

function remember<T>(model: ProjectModel, key: string, compute: () => T): T {
  let byKey = memo.get(model);
  if (!byKey) memo.set(model, (byKey = new Map()));
  if (byKey.has(key)) return byKey.get(key) as T;
  const value = compute();
  byKey.set(key, value);
  if (byKey.size > LIMIT) byKey.delete(byKey.keys().next().value as string);
  return value;
}

/** The scope's canonical path, or a 400 with the server's message when the path leaves the project. */
function canonical(model: ProjectModel, path: string): string {
  try {
    return scopeView(model, path).scope;
  } catch (e) {
    if (e instanceof ScopeError) throw new ApiError(400, e.message);
    throw e;
  }
}

/**
 * The kind of a scope, as the server names it: the project, a file, or a folder with an indexed file under it.
 * It reads every structure.file node, external ones included, the way scopeKindOf does, or 404s when none matches.
 */
function kindOf(model: ProjectModel, scope: string): ScopeKindName {
  if (scope === "") return "project";
  let folder = false;
  for (const n of model.doc.nodes) {
    if (n.kind !== "structure.file") continue;
    const path = String(n.attrs.path ?? n.id);
    if (path === scope) return "file";
    if (path.startsWith(`${scope}/`)) folder = true;
  }
  if (!folder) throw new ApiError(404, "no such scope");
  return "folder";
}

/** The call flow of a scope, as GET /scope/flow answers it for the snapshot. */
export function scopeFlowFor(snapshot: string, model: ProjectModel, path: string): ScopeFlowPayload {
  const scope = canonical(model, path);
  return remember(model, `flow\0${scope}`, () => {
    const kind = kindOf(model, scope);
    const cut = scopeView(model, scope).toDoc();
    const files = cut.doc.nodes.filter((n) => n.kind === "structure.file" && n.attrs.external !== true).map((n) => String(n.attrs.path ?? n.id));
    return { snapshot, scope, kind, ...summarizeScope(cut.doc.nodes, cut.doc.edges, files) };
  }) as ScopeFlowPayload;
}

/**
 * The execution model of a scope, as GET /scope/exec answers it. It reads the whole snapshot, not the cut. Lambdas are
 * folded into their owner unless `lambdas` is true (see execModel). The server answers the folded model only.
 */
export function scopeExecFor(snapshot: string, model: ProjectModel, path: string, opts: { lambdas?: boolean } = {}): ScopeExecPayload {
  const scope = canonical(model, path);
  const lambdas = opts.lambdas === true;
  return remember(model, `exec\0${scope}\0${lambdas ? "lambdas" : "folded"}`, () => {
    const kind = kindOf(model, scope);
    return { snapshot, kind, ...execModel(model.doc.nodes, model.doc.edges, scope, { lambdas }) };
  }) as ScopeExecPayload;
}

/** The reverse references of one node, as GET /refs answers them. */
export type ScopeRefsPayload = Refs & { snapshot: string; scope: string; kind: ScopeKindName; id: string };

/** The reverse references of a node in a scope, as GET /refs answers them. Errors as the server's route: a bad scope, then an unknown node. */
export function refsFor(snapshot: string, model: ProjectModel, path: string, id: string): ScopeRefsPayload {
  const scope = canonical(model, path);
  const kind = kindOf(model, scope);
  if (!model.byId.has(id)) throw new ApiError(404, `no node ${id}`);
  return remember(model, `refs\0${scope}\0${id}`, () => ({ snapshot, scope, kind, id, ...refsOf(scopeView(model, scope), id) })) as ScopeRefsPayload;
}

/**
 * The project-wide callers of each function of a scope: the functions that call or reference it anywhere in the project,
 * as ExecFunctionRefs (their name, file, line and whether they lie in the scope). A function with no caller is not in the
 * map. The exec index adds these to the callers it has from the scope's own exec model (see execIndex in zoom/execMap.ts).
 */
export function scopeCallersFor(model: ProjectModel, path: string): ReadonlyMap<string, readonly ExecFunctionRef[]> {
  const scope = canonical(model, path);
  return remember(model, `callers\0${scope}`, () => {
    const view = scopeView(model, scope);
    const callers = new Map<string, ExecFunctionRef[]>();
    for (const fn of view.functions()) {
      const list = refsOf(view, fn.id).calledBy.filter((r) => r.isFunction);
      if (list.length === 0) continue;
      callers.set(
        fn.id,
        list.map((r): ExecFunctionRef => ({ id: r.id, name: r.name, file: r.file, line: r.line, inScope: r.inScope, runtime: "none" })),
      );
    }
    return callers;
  }) as ReadonlyMap<string, readonly ExecFunctionRef[]>;
}

/**
 * The System view of a scope (components, routes, external systems and the verbs between them), computed from the project
 * model. Tests, fixtures and samples are left out unless `tests` is set. Kept per model, scope and flag.
 */
export function systemFor(model: ProjectModel, path: string, tests = false): SystemModel {
  const scope = canonical(model, path);
  return remember(model, `system\0${scope}\0${tests ? 1 : 0}`, () => systemModel(model, scope, { tests }));
}

/** The Pipeline view of a scope, computed from the project model the way systemFor computes the System view. */
export function pipelineFor(model: ProjectModel, path: string, tests = false): PipelineModel {
  const scope = canonical(model, path);
  return remember(model, `pipeline\0${scope}\0${tests ? 1 : 0}`, () => pipelineModel(model, scope, { tests }));
}
