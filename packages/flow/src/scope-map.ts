// The zoom map's scene model. The project, folders, files and functions of the loaded scope flows form one tree;
// the calls between them are merged so each call is counted once; and the camera rules decide what is open.
// Pure data and arithmetic: nothing here lays out or draws.
import type { ScopeExternal, ScopeFlow, ScopeFunction } from "./types.js";

/** A file box opens once it is at least this wide on screen (px) ... */
export const EXPAND_PX = 240;
/** ... and closes again only once it is narrower than this, so a box at the edge does not flicker. */
export const COLLAPSE_PX = 200;

export const PROJECT_ID = "project";

export type ScopeNodeKind = "project" | "folder" | "file" | "function";

export interface ScopeNode {
  id: string;
  kind: ScopeNodeKind;
  /** The last path segment, or the function's name. The project is "". */
  name: string;
  /** Project-relative. A folder or file has its own path; a function has the path of its file. */
  path: string;
  parent?: string;
  children: string[];
  /** Functions under the node. A folder sums its children. */
  functions: number;
  fn?: ScopeFunction;
}

export interface ScopeTree {
  nodes: Map<string, ScopeNode>;
  /** Callees outside every loaded scope, by id. */
  externals: Map<string, ScopeExternal>;
  /** Every file in the tree, in path order. */
  files: string[];
}

/** One call after merging: both ends are tree nodes or external ids. */
export interface ScopeLink {
  from: string;
  to: string;
  count: number;
  /** True when the flow the call came from marked it as leaving that flow's scope. */
  external: boolean;
  candidate: boolean;
}

/** The calls between two boxes on screen, summed. */
export interface MapEdge {
  from: string;
  to: string;
  count: number;
  /** Calls that cross the focus scope's edge. */
  stubCount: number;
  /** True when every call in the edge is a stub, so it is drawn dashed. */
  stub: boolean;
  candidate: boolean;
}

export const folderId = (path: string) => (path === "" ? PROJECT_ID : `dir:${path}`);
export const fileId = (path: string) => `file:${path}`;

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** Whether a project-relative path lies inside a scope. The project's scope "" holds every path. */
export function insideScope(path: string, scope: string): boolean {
  return scope === "" || path === scope || path.startsWith(`${scope}/`);
}

/**
 * The tree of every scope flow given. A flow in files granularity adds its files; a flow with functions adds
 * them under their files. Folders get the chain of directories above their files.
 */
export function buildScopeTree(flows: readonly ScopeFlow[]): ScopeTree {
  const nodes = new Map<string, ScopeNode>();
  const externals = new Map<string, ScopeExternal>();
  nodes.set(PROJECT_ID, { id: PROJECT_ID, kind: "project", name: "", path: "", children: [], functions: 0 });

  const attach = (parent: string, node: ScopeNode) => {
    node.parent = parent;
    nodes.set(node.id, node);
    nodes.get(parent)?.children.push(node.id);
  };
  const folder = (path: string): string => {
    const id = folderId(path);
    if (!nodes.has(id)) attach(folder(dirOf(path)), { id, kind: "folder", name: baseOf(path), path, children: [], functions: 0 });
    return id;
  };
  const file = (path: string, functions: number): string => {
    const id = fileId(path);
    const have = nodes.get(id);
    if (have) {
      have.functions = Math.max(have.functions, functions);
      return id;
    }
    attach(folder(dirOf(path)), { id, kind: "file", name: baseOf(path), path, children: [], functions });
    return id;
  };

  for (const flow of flows) {
    for (const f of flow.files) file(f.file, f.functions);
    for (const e of flow.externals) externals.set(e.id, e);
    for (const fn of flow.functions) {
      if (nodes.has(fn.id)) continue;
      const parent = file(fn.file, 0);
      attach(parent, { id: fn.id, kind: "function", name: fn.name, path: fn.file, children: [], functions: 1, fn });
    }
  }

  // Counts settle bottom-up: a file counts its functions, a folder sums its children.
  const settle = (id: string): number => {
    const n = nodes.get(id);
    if (!n) return 0;
    if (n.kind === "function") return 1;
    let sum = 0;
    for (const c of n.children) sum += settle(c);
    n.functions = n.kind === "file" ? Math.max(n.functions, sum) : sum;
    return n.functions;
  };
  settle(PROJECT_ID);

  const files = [...nodes.values()].filter((n) => n.kind === "file").map((n) => n.path).sort();
  return { nodes, externals, files };
}

/**
 * Whether a call endpoint lies inside `scope`. An external callee counts by its file, when a loaded file holds it.
 * A callee that no loaded file holds is outside every scope, so a call to it leaves even the project.
 */
function landsIn(tree: ScopeTree, id: string, scope: string): boolean {
  const n = tree.nodes.get(id);
  if (n) return insideScope(n.path, scope);
  const file = tree.externals.get(id)?.file;
  return file !== undefined && tree.nodes.has(fileId(file)) && insideScope(file, scope);
}

/**
 * The calls of every flow, each counted once. A call belongs to the deepest flow whose scope holds its caller's
 * file: a folder's flow has the calls of its files at function level, and the project's flow has the same calls
 * at file level, so the project's copy is skipped for those callers. A call that leaves the folder is therefore
 * a stub in the folder's flow and resolved in the project's, which is how a stub becomes resolved as the scope
 * widens.
 */
export function mergeCalls(flows: readonly { scope: string; flow: ScopeFlow }[]): ScopeLink[] {
  const fnFile = new Map<string, string>();
  const externalIds = new Set<string>();
  const externalFile = new Map<string, string>();
  for (const { flow } of flows) {
    for (const fn of flow.functions) fnFile.set(fn.id, fn.file);
    for (const e of flow.externals) {
      externalIds.add(e.id);
      if (e.file !== undefined) externalFile.set(e.id, e.file);
    }
  }
  // A function or external id names itself. Any other endpoint is a file path (files granularity, or module code).
  const endpoint = (id: string) => (fnFile.has(id) || externalIds.has(id) || id.startsWith("file:") ? id : `file:${id}`);
  const callerFile = (id: string): string => {
    if (id.startsWith("file:")) return id.slice("file:".length);
    return fnFile.get(id) ?? externalFile.get(id) ?? (id.includes("#") ? id.slice(0, id.indexOf("#")) : id);
  };
  const authority = (file: string): number => {
    let best = -1;
    let bestLen = -1;
    flows.forEach(({ scope }, i) => {
      if (insideScope(file, scope) && scope.length > bestLen) {
        best = i;
        bestLen = scope.length;
      }
    });
    return best;
  };

  const out = new Map<string, ScopeLink>();
  const orphanOwner = new Map<string, number>();
  flows.forEach(({ flow }, i) => {
    for (const c of flow.calls) {
      const from = endpoint(c.from);
      const to = endpoint(c.to);
      const key = `${from}\u0000${to}`;
      const auth = authority(callerFile(from));
      if (auth === -1) {
        // No given scope holds the caller: the call is taken once, from the first flow that lists it.
        const owner = orphanOwner.get(key) ?? i;
        orphanOwner.set(key, owner);
        if (owner !== i) continue;
      } else if (auth !== i) {
        continue;
      }
      const link = out.get(key);
      if (link) {
        link.count += c.count;
        link.external ||= c.external;
        link.candidate ||= c.candidate === true;
      } else {
        out.set(key, { from, to, count: c.count, external: c.external, candidate: c.candidate === true });
      }
    }
  });
  return [...out.values()];
}

/** The boxes on screen when the nodes in `open` are opened: the project's children, recursively, down to a closed node. */
export function frontier(tree: ScopeTree, open: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const visit = (id: string) => {
    const n = tree.nodes.get(id);
    if (!n) return;
    if (n.kind === "project" || (open.has(id) && n.children.length > 0)) {
      for (const c of n.children) visit(c);
    } else {
      out.push(id);
    }
  };
  visit(PROJECT_ID);
  return out;
}

/**
 * The box a call endpoint is drawn at: the endpoint itself when it is on screen, else its deepest visible
 * ancestor. An open file stands for its own module-level calls. An external callee that a loaded file holds is
 * drawn at that file. Anything else has no box.
 */
export function boxOf(tree: ScopeTree, open: ReadonlySet<string>, visible: ReadonlySet<string>, id: string): string | undefined {
  if (visible.has(id)) return id;
  if (!tree.nodes.has(id)) {
    const file = tree.externals.get(id)?.file;
    if (file !== undefined && tree.nodes.has(fileId(file))) return boxOf(tree, open, visible, fileId(file));
    return tree.externals.has(id) ? id : undefined;
  }
  if (tree.nodes.get(id)?.kind === "file" && open.has(id)) return id;
  let cur = tree.nodes.get(id);
  while (cur?.parent !== undefined) {
    if (visible.has(cur.parent)) return cur.parent;
    cur = tree.nodes.get(cur.parent);
  }
  return undefined;
}

/**
 * The calls drawn between boxes. `focus` is a node id, and its path is the scope. A call is a stub when exactly
 * one of its ends lies inside that scope, so the stub turns into a resolved call once the focus widens to take in
 * the other end. An unknown focus counts as the project, where no call is a stub.
 */
export function mapEdges(tree: ScopeTree, links: readonly ScopeLink[], open: ReadonlySet<string>, focus: string): MapEdge[] {
  const scope = tree.nodes.get(focus)?.path ?? "";
  const visible = new Set(frontier(tree, open));
  const acc = new Map<string, MapEdge>();
  for (const l of links) {
    const a = boxOf(tree, open, visible, l.from);
    const b = boxOf(tree, open, visible, l.to);
    if (a === undefined || b === undefined || a === b) continue;
    const stub = landsIn(tree, l.from, scope) !== landsIn(tree, l.to, scope);
    const key = `${a}\u0000${b}`;
    const e = acc.get(key) ?? { from: a, to: b, count: 0, stubCount: 0, stub: false, candidate: false };
    e.count += l.count;
    if (stub) e.stubCount += l.count;
    e.candidate ||= l.candidate;
    acc.set(key, e);
  }
  for (const e of acc.values()) e.stub = e.count > 0 && e.stubCount === e.count;
  return [...acc.values()];
}

/** How deep a node sits: the project is 0, its folders 1, and so on. Unknown ids are -1. */
export function depthOf(tree: ScopeTree, id: string): number {
  let depth = -1;
  for (let cur = tree.nodes.get(id); cur; cur = cur.parent === undefined ? undefined : tree.nodes.get(cur.parent)) depth += 1;
  return depth;
}

/** The kind of a node, or undefined when the tree has no such node. */
export function levelOf(tree: ScopeTree, id: string): ScopeNodeKind | undefined {
  return tree.nodes.get(id)?.kind;
}

/** The nodes that must be open for `focus` to be on screen: every folder and file above it, and the focus itself when it has children. */
export function openFor(tree: ScopeTree, focus: string): Set<string> {
  const open = new Set<string>();
  const focusNode = tree.nodes.get(focus);
  if (!focusNode) return open;
  if (focusNode.children.length > 0 && focusNode.kind !== "function") open.add(focus);
  for (let p = focusNode.parent; p !== undefined; p = tree.nodes.get(p)?.parent) {
    if (p !== PROJECT_ID) open.add(p);
  }
  return open;
}

/**
 * Which node the camera is on: the deepest node under `point` among the placed boxes. Ties go to the smaller
 * box. Returns undefined when no box holds the point.
 */
export function focusAt(tree: ScopeTree, boxes: readonly { id: string; x: number; y: number; w: number; h: number }[], x: number, y: number): string | undefined {
  let best: { id: string; depth: number; area: number } | undefined;
  for (const b of boxes) {
    if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) continue;
    const depth = depthOf(tree, b.id);
    const area = b.w * b.h;
    if (!best || depth > best.depth || (depth === best.depth && area < best.area)) best = { id: b.id, depth, area };
  }
  return best?.id;
}

/**
 * The hysteresis step. `current` is the open node and `currentWidth` its width on screen, or null when none is
 * open. `under` is the deepest node under the focus and its width. The open node stays open until it is narrower
 * than COLLAPSE_PX; a new node opens once it is wider than EXPAND_PX.
 */
export function nextOpen(current: string | null, currentWidth: number | null, under: { id: string; width: number } | null): string | null {
  let next = current !== null && currentWidth !== null && currentWidth >= COLLAPSE_PX ? current : null;
  if (under !== null && under.width > EXPAND_PX) next = under.id;
  return next;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Camera {
  k: number;
  x: number;
  y: number;
}

/**
 * The camera that centres a world rectangle in the viewport, scaled so it fills the viewport with `padding` to
 * spare. The scale is clamped to [minK, maxK].
 */
export function fitCamera(target: Rect, viewport: { width: number; height: number }, opts: { padding?: number; minK?: number; maxK?: number } = {}): Camera {
  const padding = opts.padding ?? 0.92;
  const minK = opts.minK ?? 0.02;
  const maxK = opts.maxK ?? 16;
  const fit = Math.min(viewport.width / Math.max(target.w, 1), viewport.height / Math.max(target.h, 1)) * padding;
  const k = Math.min(maxK, Math.max(minK, fit));
  return {
    k,
    x: viewport.width / 2 - (target.x + target.w / 2) * k,
    y: viewport.height / 2 - (target.y + target.h / 2) * k,
  };
}

/** The world rectangle a camera shows in a viewport. */
export function visibleWorld(camera: Camera, viewport: { width: number; height: number }): Rect {
  return { x: -camera.x / camera.k, y: -camera.y / camera.k, w: viewport.width / camera.k, h: viewport.height / camera.k };
}

/** The nodes from the project down to `id`, for the breadcrumb. */
export function breadcrumb(tree: ScopeTree, id: string): ScopeNode[] {
  const out: ScopeNode[] = [];
  for (let cur = tree.nodes.get(id); cur; cur = cur.parent === undefined ? undefined : tree.nodes.get(cur.parent)) out.unshift(cur);
  return out;
}

/**
 * The URL that shows a focus: `scope` is the project-relative path of a folder or file (a function's file), and
 * `fn` names a function, when the focus is one.
 */
export function urlFocus(tree: ScopeTree, id: string): { scope: string; fn?: string } | undefined {
  const n = tree.nodes.get(id);
  if (!n) return undefined;
  return n.kind === "function" ? { scope: n.path, fn: n.id } : { scope: n.path };
}

/** The focus a URL names. `fn` wins when it is in the tree; else the scope's file, else its folder. */
export function focusFromUrl(tree: ScopeTree, scope: string, fn?: string): string | undefined {
  if (fn !== undefined && tree.nodes.get(fn)?.kind === "function") return fn;
  if (scope === "") return PROJECT_ID;
  if (tree.nodes.get(fileId(scope))) return fileId(scope);
  if (tree.nodes.get(folderId(scope))) return folderId(scope);
  return undefined;
}

/** A colour band per file, given out in path order and wrapping after `bands` colours. */
export function fileBands(tree: ScopeTree, bands: number): Map<string, number> {
  const out = new Map<string, number>();
  const n = Math.max(1, bands);
  tree.files.forEach((file, i) => out.set(file, i % n));
  return out;
}
