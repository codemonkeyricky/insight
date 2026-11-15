import type { IRNode, NodeId } from "@insight/ir";

/** A package root: the directory a package's files belong to, and its name. */
export interface PackageRoot {
  path: string;
  name: string;
}

/** Directories whose package.json files describe fixtures, not packages of the project. */
const NOT_A_PACKAGE = /(^|\/)(node_modules|test|tests|fixtures|__fixtures__|samples)(\/|$)/;

const dirOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(0, slash) : ".";
};

const lastSegment = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** The buildSystem a structure.package node names, or undefined when it names none. */
function buildSystemOf(node: IRNode): string | undefined {
  const value = (node.attrs as { buildSystem?: unknown }).buildSystem;
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The structure.package node that names a directory's package when several build systems describe it. The node whose
 * buildSystem sorts first wins; a node with no buildSystem sorts last; ties go to the lower node id. So the result does
 * not depend on record order.
 */
function winningPackage(a: IRNode, b: IRNode): IRNode {
  const sa = buildSystemOf(a);
  const sb = buildSystemOf(b);
  if (sa !== sb) {
    if (sa === undefined) return b;
    if (sb === undefined) return a;
    return sa < sb ? a : b;
  }
  return a.id <= b.id ? a : b;
}

/**
 * Package roots come from structure.package nodes when a frontend emits them, and otherwise
 * from package.json files among the structure.file nodes. The TypeScript frontend emits no
 * package nodes, so the second source is the one that usually applies.
 */
export function packageRoots(nodes: Iterable<IRNode>): PackageRoot[] {
  const all = [...nodes];
  const roots = new Map<string, PackageRoot>();
  const winners = new Map<string, IRNode>();
  for (const node of all) {
    if (node.kind !== "structure.package") continue;
    const attrs = node.attrs as { root?: unknown };
    const path = typeof attrs.root === "string" ? attrs.root : node.id;
    const current = winners.get(path);
    winners.set(path, current === undefined ? node : winningPackage(current, node));
  }
  for (const [path, node] of winners) {
    const attrs = node.attrs as { name?: unknown };
    roots.set(path, { path, name: typeof attrs.name === "string" ? attrs.name : path === "." ? "." : lastSegment(path) });
  }
  for (const node of all) {
    if (node.kind !== "structure.file") continue;
    if (lastSegment(node.id) !== "package.json") continue;
    const dir = dirOf(node.id);
    if (roots.has(dir) || NOT_A_PACKAGE.test(dir)) continue;
    roots.set(dir, { path: dir, name: dir === "." ? "." : lastSegment(dir) });
  }
  return [...roots.values()];
}

/** The nearest package root above a file. The root "." matches everything but ranks lowest. */
export function rootOf(roots: PackageRoot[], file: NodeId): PackageRoot | undefined {
  let best: PackageRoot | undefined;
  let bestRank = -2;
  for (const root of roots) {
    if (root.path !== "." && !file.startsWith(`${root.path}/`)) continue;
    const rank = root.path === "." ? -1 : root.path.length;
    if (rank > bestRank) {
      best = root;
      bestRank = rank;
    }
  }
  return best;
}

/** Which module each file and each node belongs to. A module is a package, or a top-level folder in a repo with no package metadata. */
export interface ModuleMap {
  roots: PackageRoot[];
  /** True when no package has a path of its own: the module is the top-level folder. */
  generic: boolean;
  moduleOfFile(file: string): string;
  /** The module of a node (its structure.module ancestor, else its file), or undefined when no file is known. */
  moduleOf(nodeId: string): string | undefined;
}

/**
 * The module map of a set of IR nodes. It uses the same package roots as the Arch model, so a file's module here is the
 * package archModel assigns it. A repo whose only root is "." has no package metadata, so each top-level folder is a module.
 */
export function moduleMap(nodes: Iterable<IRNode>): ModuleMap {
  const all = [...nodes];
  const roots = packageRoots(all);
  const generic = roots.every((r) => r.path === ".");
  const byId = new Map<string, IRNode>();
  for (const n of all) byId.set(n.id, n);

  const moduleOfFile = (file: string): string => {
    if (!generic) return rootOf(roots, file)?.path ?? ".";
    const slash = file.indexOf("/");
    return slash >= 0 ? file.slice(0, slash) : ".";
  };

  const moduleOf = (nodeId: string): string | undefined => {
    let cur: IRNode | undefined = byId.get(nodeId);
    for (let guard = 0; cur !== undefined && guard < 10_000; guard++) {
      if (cur.kind === "structure.module") return cur.id;
      cur = cur.parent === undefined ? undefined : byId.get(cur.parent);
    }
    const node = byId.get(nodeId);
    const file = node?.span?.file ?? nodeId.split("#")[0];
    if (file === undefined || file === "") return undefined;
    return moduleOfFile(file);
  };

  return { roots, generic, moduleOfFile, moduleOf };
}
