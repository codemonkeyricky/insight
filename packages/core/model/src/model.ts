import type { IREdge, IRDocument, IRNode, NodeId } from "@insight/ir";
import { edgeTargets } from "@insight/sdk";
import { fileResolver } from "./scope.js";

/** A relation kind the model normalizes. Each comes from one edge kind; see RELATION_EDGES. */
export type RelKind = "call" | "reference" | "dispatch" | "spawn";

const RELATION_EDGES: ReadonlyMap<string, RelKind> = new Map([
  ["calls.call", "call"],
  ["calls.reference", "reference"],
  ["concurrency.dispatches", "dispatch"],
  ["concurrency.spawns", "spawn"],
]);

/**
 * One directed relation between two nodes, normalized from an edge. A candidate set expands to one
 * relation per candidate, each with `candidate: true`. `how` is the edge's `how` attribute, when it has one.
 */
export interface Rel {
  kind: RelKind;
  from: NodeId;
  to: NodeId;
  how?: string;
  candidate: boolean;
  edge: IREdge;
}

/** A function node, with its file resolved by the model. */
export interface FunctionEntity {
  id: NodeId;
  name: string;
  file: string;
  span?: IRNode["span"];
  parent?: NodeId;
  anonymous: boolean;
}

/**
 * A folder of the project tree. Its id is `dir:<path>`; the root is `dir:`. `dirs` and `files` are
 * sorted. The subtree counts cover every file and function under the folder, at any depth.
 */
export interface DirEntity {
  id: string;
  path: string;
  name: string;
  parent?: string;
  dirs: string[];
  files: string[];
  subtreeFiles: number;
  subtreeFunctions: number;
}

export interface ProjectTree {
  root: string;
  dirs: Map<string, DirEntity>;
}

export interface ProjectModel {
  /** The original document, untouched. Lenses still read it. */
  doc: IRDocument;
  byId: Map<NodeId, IRNode>;
  /** The file of any node, through its parent chain. Memoized. */
  fileOf(id: NodeId): string | undefined;
  /** Project-relative paths of the files, sorted. */
  files: string[];
  tree: ProjectTree;
  functions: FunctionEntity[];
  functionById: Map<NodeId, FunctionEntity>;
  relations: Rel[];
  /** Relations by their `from` node. */
  out: Map<NodeId, Rel[]>;
  /** Relations by their `to` node: reverse references. */
  in: Map<NodeId, Rel[]>;
}

export const ROOT_DIR = "dir:";

const dirId = (path: string): string => (path === "" ? ROOT_DIR : `dir:${path}`);

/** Builds the whole-project model of one IR document. Pure and browser-safe: no node: imports. */
export function buildProjectModel(doc: IRDocument): ProjectModel {
  const byId = new Map<NodeId, IRNode>(doc.nodes.map((n) => [n.id, n]));
  const fileOf = fileResolver(byId);

  const fileSet = new Set<string>();
  for (const n of doc.nodes) {
    if (n.kind !== "structure.file" || n.attrs.external === true) continue;
    const path = n.attrs.path;
    fileSet.add(typeof path === "string" ? path : n.id);
  }
  const files = [...fileSet].sort();

  const functions: FunctionEntity[] = [];
  const functionById = new Map<NodeId, FunctionEntity>();
  for (const n of doc.nodes) {
    if (n.kind !== "structure.function") continue;
    const file = fileOf(n.id);
    if (file === undefined) continue;
    // A module entry is named by its file ("verify.worker.ts · top level"), not the IR's "(module)". A method keeps its class.
    const base = file.slice(file.lastIndexOf("/") + 1);
    const name =
      n.attrs.module === true
        ? `${base} · top level`
        : typeof n.attrs.qualifiedName === "string"
          ? n.attrs.qualifiedName
          : typeof n.attrs.name === "string"
            ? n.attrs.name
            : (n.id.split("#")[1] ?? n.id);
    const fn: FunctionEntity = {
      id: n.id,
      name,
      file,
      ...(n.span ? { span: n.span } : {}),
      ...(n.parent !== undefined ? { parent: n.parent } : {}),
      anonymous: n.attrs.anonymous === true,
    };
    functions.push(fn);
    functionById.set(n.id, fn);
  }
  functions.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || (a.span?.start[0] ?? 0) - (b.span?.start[0] ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const tree = buildTree(files, functions);

  const relations: Rel[] = [];
  const out = new Map<NodeId, Rel[]>();
  const inn = new Map<NodeId, Rel[]>();
  const push = (m: Map<NodeId, Rel[]>, k: NodeId, r: Rel) => {
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  };
  for (const e of doc.edges) {
    const kind = RELATION_EDGES.get(e.kind);
    if (kind === undefined) continue;
    const { nodes, candidates } = edgeTargets(e);
    const how = typeof e.attrs?.how === "string" ? e.attrs.how : undefined;
    const targets: Array<[NodeId, boolean]> = nodes.length > 0 ? nodes.map((id) => [id, false]) : candidates.map((id) => [id, true]);
    for (const [to, candidate] of targets) {
      const rel: Rel = { kind, from: e.from, to, ...(how !== undefined ? { how } : {}), candidate, edge: e };
      relations.push(rel);
      push(out, rel.from, rel);
      push(inn, rel.to, rel);
    }
  }

  return { doc, byId, fileOf, files, tree, functions, functionById, relations, out, in: inn };
}

/** Folders from the file paths: every folder on a file's path is a DirEntity, and each count rolls up to all its ancestors. */
function buildTree(files: string[], functions: FunctionEntity[]): ProjectTree {
  const dirs = new Map<string, DirEntity>();
  const entity = (path: string): DirEntity => {
    const hit = dirs.get(path);
    if (hit) return hit;
    const slash = path.lastIndexOf("/");
    const parentPath = slash === -1 ? "" : path.slice(0, slash);
    const e: DirEntity = {
      id: dirId(path),
      path,
      name: path === "" ? "" : path.slice(slash + 1),
      ...(path === "" ? {} : { parent: dirId(parentPath) }),
      dirs: [],
      files: [],
      subtreeFiles: 0,
      subtreeFunctions: 0,
    };
    dirs.set(path, e);
    return e;
  };
  entity("");

  // Every folder between a file and the root gets an entity, and each folder lists its child folders.
  const dirOf = (file: string): string => {
    const slash = file.lastIndexOf("/");
    return slash === -1 ? "" : file.slice(0, slash);
  };
  const ancestors = (path: string): string[] => {
    const chain: string[] = [];
    let cur = path;
    while (cur !== "") {
      chain.push(cur);
      const slash = cur.lastIndexOf("/");
      cur = slash === -1 ? "" : cur.slice(0, slash);
    }
    chain.push("");
    return chain;
  };
  for (const file of files) {
    const dir = dirOf(file);
    for (const path of ancestors(dir)) {
      const e = entity(path);
      if (path === dir) e.files.push(file);
    }
    for (const path of ancestors(dir)) {
      if (path === "") continue;
      const parent = entity(dirOf(path));
      if (!parent.dirs.includes(dirId(path))) parent.dirs.push(dirId(path));
    }
    for (const path of ancestors(dir)) entity(path).subtreeFiles++;
  }
  for (const fn of functions) for (const path of ancestors(dirOf(fn.file))) entity(path).subtreeFunctions++;

  for (const e of dirs.values()) {
    e.dirs.sort();
    e.files.sort();
  }
  return { root: ROOT_DIR, dirs };
}

