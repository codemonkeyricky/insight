# Writing a lens

A lens reads the IR and reports findings and views. It sees only `IRView`, never a parser object, and it never reads source files directly. Frontends make the IR (see [writing-a-frontend.md](writing-a-frontend.md)); lenses analyse it.

The contract is the `Lens` interface in `packages/core/sdk/src/types.ts`:

```ts
interface Lens {
  id: string;
  title: string;
  requires: FacetId[];      // hard needs; without them the lens is unavailable
  optional?: FacetId[];     // read when present
  after?: string[];         // run after these lenses, when they are present
  run(ir: IRView, ctx: LensContext): Promise<LensResult>;
}
```

## Where it lives

Lenses are plugins, found the same way as frontends (see the frontend guide, "Where it lives"). `packages/lens/*` is the usual place. The manifest:

```json
{
  "id": "lens-example",
  "version": "0.1.0",
  "description": "Example: flags functions with no callers",
  "irVersion": "^1.0",
  "roles": { "lens": "dist/index.js" }
}
```

The loader checks that the module's default export has a `run` function and that `lens.id` equals the manifest `id`. A mismatch disables the plugin with a reason. The manifest `version` is part of the reuse key (see below), so bump it when the lens's output changes.

## What a run gets

`run(ir, ctx)` receives:

- `ir`: an `IRView` over the current snapshot (below).
- `ctx.root`: the project (`path`, `name`, `allowBuildTools`).
- `ctx.config`: the lens's settings, read from `.insight/lenses/<id>.json` in the project. `undefined` when there is no file. Parse and check it yourself; it is `unknown`.
- `ctx.previous`: this lens's result from the last run, if it was ok.
- `ctx.resultOf(id)`: the result of another lens that ran earlier in this pass. Use it only for lenses named in `after`.

### Ordering and availability

- `requires` lists facets the lens cannot work without. If no frontend provides one of them, the lens is not run and its status is `unavailable`, with a reason such as `unavailable: no frontend provides sync, concurrency`.
- `optional` facets are not checked. Test `ir.hasFacet(...)` if the result depends on them. The lock-order lens reads `effects` only when a frontend provides it.
- `after` orders lenses. A name that is not installed is ignored. Cycles in `after` are an error.
- A lens that throws gets status `error` with the message. The other lenses still run.

### Reuse

A lens is not run again when its inputs have not changed. The inputs are its manifest `version`, its `config`, and the nodes and edges of the facets in `requires` and `optional`. Findings are not inputs. So a lens must be a pure function of those. Do not read the clock, the filesystem or environment variables inside `run`.

## The IR view

`IRView` is read-only and indexed. The methods:

| Method | Returns |
| --- | --- |
| `node(id)` | one node, or `undefined` |
| `nodes({ facet?, kind? })` | nodes, subkind-aware: `kind: "sync.lock-acquire"` also returns `sync.rwlock-acquire` and any plugin kind that extends it |
| `edges({ facet?, kind? })` | edges, same query |
| `out(id, query?)` / `in(id, query?)` | edges leaving or entering a node |
| `children(id, query?)` | nodes whose `parent` is `id` |
| `trace(starts, opts)` | a `Reach` (below) |
| `findings()` | IR findings (parse errors and frontend findings) |
| `facets()` / `hasFacet(f)` | which facets have records |
| `opaqueKinds()` | kinds in the snapshot that the registry does not know |

Helpers in `@insight/sdk`:

- `edgeTargets(edge)` splits an edge's `to` into `{ nodes, candidates, unresolved? }`. Use it instead of testing the union by hand.
- `ownerOf(view, id)` is the nearest enclosing function-like node, and `enclosing(view, id, kind)` is the nearest ancestor of a given kind.

### trace

`trace(starts, opts)` walks chains of edges:

- `follow`: edge kinds to follow. Subkinds are included.
- `direction`: `"out"` (callees, imports; the default) or `"in"` (callers, importers).
- `uncertain`: `"may"` (the default) also follows candidate sets. `"exact"` follows only single-target edges.
- `maxDepth`: default 16.
- `stopAt(node)`: do not expand past nodes this returns true for.

The result `Reach` has:

- `nodes`: a map from node id to depth in hops, including the start nodes.
- `pathsTo(id)`: the shortest path from a start node, or `undefined`.
- `cycles`: strongly connected groups of two or more nodes, or a node with an edge to itself.
- `deadEnds`: followed edges that stopped at an unresolved reference. Report these; do not drop them.

## What to return

```ts
interface LensResult {
  findings: LensFinding[];
  views: LensView[];
  metrics: Record<string, number>;
}
```

### Findings and their ids

Each finding has `lens`, `id`, `severity` (`info`, `warning` or `error`), `message`, and optionally `nodes` (node ids it is about) and `span`. The core sets `lens` to your id for you.

**Give every finding a stable `id`.** The id is part of its review key, `<lens>#<id>`. The review checklist, the review decisions and the comparison between commits all use that key. If you leave the id out, the core uses `<lens>:<index>`, which changes when findings are reordered. Derive the id from what the finding is about:

- good: `cycle:accounts_mu|audit_mu` (the lock-order lens), or the node id of the function that has the problem;
- avoid: a list position, or a line number. A finding whose id includes a line (for example `@137`) gets a new key when the line moves, and its old decision goes stale. Use the node id and keep the line in `span` and `message`.

If two findings share an id, the core appends `#<i>` to the second. The diff gives repeats `~2`, `~3`. Neither is a reason to rely on duplicates; make ids unique.

### Views

- `graph`: `{ type: "graph", id, title, nodes: [{ id, label, group?, span? }], edges: [{ from, to, kind, label?, confidence?, span? }] }`.
- `table`: `{ type: "table", id, title, columns, rows }`. Cells are strings, numbers, booleans or `null`.
- `tree`: `{ type: "tree", id, title, root: { label, children? } }`.

Give each view an `id` that is unique within the lens. The lens page draws graph views with cytoscape and renders table views as HTML. It does not draw tree views yet: a lens can return one, and the API passes it on, but the page shows nothing for it.

### Metrics

`metrics` is a flat record of numbers, shown on the lens page. Use it for counts (`locks`, `orderEdges`, `cycles`, `unknownLocks` in the lock-order lens) so that a reader can see how much the lens actually saw. A lens that finds nothing because it saw nothing should say so in `metrics`, not return an empty result that looks like a clean bill of health.

## Example: the lock-order lens

`packages/lens/lock-order/src/index.ts` is a good model. It:

- requires `structure`, `sync`, `concurrency` and `calls`, and reads `effects` as optional;
- builds held-before edges from `sync.lock-acquire` and `sync.lock-release` nodes, in source order within each function;
- follows `calls.call` edges with `ir.trace(..., { follow: ["calls.call"], uncertain: "exact" })` to find locks a callee takes while the caller holds one, and reports those edges as `inferred`;
- reports each cycle as a finding with id `cycle:<locks>`, and a self edge as a warning;
- returns a graph view, a table view and metrics (`locks`, `orderEdges`, `cycles`, `unknownLocks`).

Its limits are written in the doc comment of `lockOrderEdges`: a lock is held until its release in the same function, and cross-call edges use exact targets only.

## Skeleton

```ts
import type { Lens, LensFinding } from "@insight/sdk";

const lens: Lens = {
  id: "lens-example",
  title: "Example",
  requires: ["structure", "calls"],
  async run(ir) {
    const findings: LensFinding[] = [];
    const functions = ir.nodes({ facet: "structure", kind: "structure.function" });
    let unreferenced = 0;
    for (const fn of functions) {
      if (ir.in(fn.id, { facet: "calls", kind: "calls.call" }).length === 0) {
        unreferenced += 1;
        findings.push({
          lens: "lens-example",
          id: fn.id,
          severity: "info",
          message: `${String(fn.attrs.name)} has no callers in this project`,
          nodes: [fn.id],
          ...(fn.span ? { span: fn.span } : {}),
        });
      }
    }
    return { findings, views: [], metrics: { functions: functions.length, unreferenced } };
  },
};
export default lens;
```

Note that a function with no callers may still be an entry point. A lens that reports it should say so in its message or leave it at `info`.

## Testing

Build IR in the test with `irFixtures` from `@insight/sdk`, not by running a frontend:

- `irFixtures.span(file, startLine, startCol, endLine, endCol)`
- `irFixtures.node(id, facet, kind, { attrs, parent, span, confidence })`
- `irFixtures.edge(from, to, facet, kind, { attrs, span, confidence })`, where `to` is a node id, an array of ids (a candidate set) or `{ unresolved: { scheme, text } }`
- `irFixtures.finding(message, { severity, nodes, span })`
- `irFixtures.view({ nodes, edges, findings })`

Then call `lens.run(view, ctx)` directly and assert on the findings, their ids and the metrics. `packages/lens/lock-order/test/lock-order.test.ts` does this with a small hand-built fixture, including a deliberate cycle, an inferred cross-call edge and a case with no cycle. Cover those three cases in any lens that has them, and check the `requires` path too: the lens should report unavailable when a required facet is missing.

For the end to end check, index a real project with the CLI and open the lens page:

```sh
pnpm -r build
node packages/cli/dist/cli.js index /path/to/project
```
