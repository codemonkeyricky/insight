# Reverse symbol lookup

## Goal

Let a reader start from any resolved symbol (for example, `validatePhysicsModel` in cognition's
`src/physics/validate.ts`) and explore its complete incoming call chain: direct callers, callers of those callers, and so
on. The result must be bounded, cycle-safe, source-linked, and explicit about what the index cannot see.

## Review of the first draft (2026-11-14)

The goal and the guard rails (symbol ids, caps, candidates never merged with exact calls) stand. Four assumptions were
wrong or vague and are corrected below.

1. **`IRView.trace` is the wrong base.** `packages/core/sdk/src/trace.ts` walks raw IR edges. It does not fold anonymous
   callers into their owner, does not map a spawn node to the function that spawns, knows nothing about scopes, and keeps
   only one shortest parent per node. The "Called by" list (`refsOf`, `packages/core/model/src/refs.ts`) does all three
   on `ProjectModel.in`. The new query must build on the same relations and the same owner/spawn mapping, so that depth 1
   of the chain equals the existing "Called by" list row for row. Only `findCycles` (Tarjan) is reused from `trace.ts`.
2. **The IR has no unresolved calls to report.** The TS frontend emits a `calls.call` edge only when the callee resolves
   to a function or to an interface candidate set (`packages/frontend/typescript/src/extract.ts:1439-1474`). Any other
   call emits nothing. `{unresolved}` targets exist only for imports (`ts.import`) and includes (`cpp.include`). The
   chain therefore cannot say "N unresolved calls may reach this". It *can* say where the index is blind:
   - a function on the chain is also **passed as a value** (`calls.reference`, how `value`/`closure`), so it may run from
     places the IR does not model;
   - a candidate set into it was **truncated** (`attrs.truncated` on interface dispatch, `MAX_DISPATCH_TARGETS`);
   - a caller is **module top level** (it runs when its file is imported; importers are not callers).
   Emitting unresolved call edges from the frontends is a separate, optional phase (P6).
3. **There is one compute path, not three.** The live, demo and hosted clients all compute refs in the browser from
   `model.json` through `apps/web/src/model/payloads.ts` (`refsFor`). `api.ts:445` uses `liveModel`, `staticApi.ts:346`
   uses `modelOf`, and `hostedApi` is built on `makeStaticApi`. The server route `GET /api/projects/:id/refs`
   (`apps/server/src/app.ts:398` → `reader.ts:449 scopeRefsOf`) exists for parity and is checked by
   `apps/web/test/modelParity.test.ts`. The new query follows exactly that pattern.
4. **"Navigate without losing scope context" conflicts with today's links.** A `RefItem` outside the scope switches the
   scope to the caller's file (`RefLists.tsx:97`). The chain must survive that navigation, so its root is anchored in the
   URL (`trace=<id>`, below), independent of `fn=`.

The Find palette (step 6 of the first draft) already lists every function with its qualified name (`FunctionEntity.name`
uses `attrs.qualifiedName`) and `file:line` (`FindPalette.tsx:20-36`). What it lacks is an action that opens the chain.

## Design

### Relations followed

The chain uses `ProjectModel.in`, with `refsOf`'s owner folding (`ownerOf`) and its spawn mapping (a spawn node's caller is
the function that starts it, labelled `spawns <api>`).

| Relation (`RelKind` / `how`) | Row tag | Expanded by default |
|---|---|---|
| `call` (exact) | none | yes |
| `call` candidate (`how: interface`) | `possible` | only with **Possible callers** on |
| `dispatch` (await, start, callback, timer, microtask, message) | `dispatch` / `message` | yes |
| `spawn` | `spawns worker` / `spawns process` | yes |
| `reference` how `new`, `jsx`, `handler` | `new` / `jsx` / `handler` | yes (these are calls in effect) |
| `reference` how `value`, `closure` | `passed as value` | only with **Possible callers** on; also sets the blind-spot hint |

A file row (module top level) is a leaf with the terminal reason `module`.

### Model query: `packages/core/model/src/callers.ts`

```ts
export interface CallerOptions {
  maxDepth?: number;        // default from P0 sizing; hops past it are not expanded
  maxNodes?: number;        // default from P0 sizing; the graph stops growing past it
  possible?: boolean;       // follow candidate sets and value references (default false; rows are listed either way)
  stayInScope?: boolean;    // callers outside the view are listed but not expanded (default false)
}

export interface CallerNode {
  id: NodeId;
  name: string; file: string; line: number;   // as RefRow (describe())
  isFunction: boolean;
  inScope: boolean;
  depth: number;                               // shortest hop count from the root
  /** Exact when some path from the root uses only exact relations; possible otherwise. */
  certainty: "exact" | "possible";
  /** Why this node's callers were not expanded. Absent when they were. */
  stop?: "none" | "module" | "outside-scope" | "depth" | "nodes" | "possible-off";
  /** Callers that exist but were left out by a cap (for "+N more"). */
  hidden?: number;
  /** Blind spots on this node: passed as a value, or the target of a truncated candidate set. */
  blind?: Array<"value" | "truncated">;
}

export interface CallerEdge {
  from: NodeId;             // the caller
  to: NodeId;               // the callee, nearer the root
  kind: RelKind; how?: string; label?: string;
  candidate: boolean;       // every relation of the group is a candidate
  count: number;            // relations collapsed into this edge
  site?: { file: string; line: number };       // first call site, as rowsOf
  /** True when `from` is in the same strongly connected group as `to` and not deeper: the edge closes a cycle. */
  back: boolean;
}

export interface CallerGraph {
  root: NodeId;
  nodes: CallerNode[];      // root first, then BFS order (refsOf's order() within a level)
  edges: CallerEdge[];      // sorted by (to, order of from)
  cycles: NodeId[][];       // findCycles over the discovered subgraph
  truncated?: { reason: "depth" | "nodes"; at: number };
  /** Counts for the summary line and the completeness note. */
  stats: { callers: number; levels: number; possible: number; blind: number; outsideScope: number };
}

export function callerGraph(view: ScopeView, id: NodeId, opts?: CallerOptions): CallerGraph;
```

The algorithm is a breadth-first walk from the root over folded incoming relations, one level at a time. Each node is
canonical, so a node reached by several paths is one node with several incoming edges, which handles diamonds. All
discovered caller→callee pairs are recorded as edges, even when the caller was already seen; that is how the multiple
paths survive. A node is expanded only if its depth is below `maxDepth`, the node budget is not exhausted, and its stop
rules allow it (scope, possible). When it is skipped, the reason goes in `stop` and the number of unseen callers goes in
`hidden`. After the walk, `findCycles` finds the strongly connected groups and edges inside a group are marked `back`.
Output is deterministic: rows within a level sort with refsOf's `order()` (in scope first, then file, line, name, id).

Refactor that comes with it: move `ownerOf`, `anonymousOwned` and the spawn mapping out of `refsOf` into a shared helper
(`refs-common.ts`), so the two queries cannot drift. `refsOf`'s output must be byte-identical before and after.

Invariant (unit-tested): the depth-1 callers of `callerGraph(view, id)` equal `refsOf(view, id).calledBy` on
(id, kind, label, count, candidate, inScope).

### Payload and API

- `apps/web/src/model/payloads.ts`: `callerGraphFor(snapshot, model, path, id, opts)` → `CallerGraphPayload`
  (`CallerGraph & { snapshot, scope, kind, id }`). It uses the same errors as `refsFor` (bad scope, then 404 for an
  unknown id) and is memoized with `remember(model, "callerGraph\0<scope>\0<id>\0<optsKey>")`.
  Name it *callerGraph* everywhere: `scopeCallersFor` / `getScopeCallers` already exist and mean something else
  (one-hop callers of every function in a scope, for the exec index).
- `apps/web/src/api.ts` (liveApi) and `apps/web/src/staticApi.ts` get
  `getCallerGraph(id, scope, fnId, opts)`. The hosted client inherits it through `makeStaticApi`; check that it does.
- Server parity: `reader.ts` `scopeCallerGraphOf`, plus `GET /api/projects/:id/callers?path=&id=&depth=&nodes=&possible=&stayInScope=`
  in `app.ts`, next to `/refs`. Query parsing: integers clamped to [1, hard max]; flags `1`/`0`.

### UI

**Where.** A third section, **Caller chain**, in the pinned reference block (`FunctionRefs` / `RefLists.tsx`, mounted by
`CodePane.tsx` and `FunctionSource.tsx`), below "Called by" and "Calls". It starts collapsed and shows only a summary line.
The existing "Called by" list stays unchanged.

**Tree.** It uses the WAI-ARIA tree pattern (`role=tree` / `treeitem`, `aria-level`, `aria-expanded`, roving tabindex). Keys: ↑/↓ move,
→ expands or enters, ← collapses or goes to the parent, Home/End, Enter opens the function, `*` expands siblings. The tree is
rendered lazily from the graph: a row's children are the edges into it. Each row shows the name, `file:line`, the kind
tag, `×count`, a `possible` tag (dashed outline, never the solid style of exact rows), dimmed styling when outside the
scope, and `+N more` when capped.
- **Recursion:** a row whose node is already an ancestor on the same path is drawn as a leaf `↻ calls back into <name>`
  and cannot expand.
- **Multiple paths:** a node reached again on another path shows `also via N paths`. Its subtree starts collapsed, so
  expansion stays linear in the number of nodes rather than the number of paths.
- **Blind spots:** an icon on the row with a tooltip, for example "passed as a value at App.tsx:88; may also run from code
  the index cannot follow".

**Toolbar.** Depth (1, 2, 3, 6, max), **Expand all** (to the chosen depth, capped at 500 rendered rows with a notice),
**Possible callers**, and **Stay in scope**. Summary line: `34 callers across 5 levels · 3 possible · capped at 300 nodes`.

**Completeness note.** It always shows one of these two:
- "Complete within the index." This is shown only when `stats.blind === 0`, there is no truncation, and Possible is on or
  no possible rows exist.
- Otherwise: "Exact within the index. 4 functions on this chain are passed as values or dispatched through a truncated
  interface set, so they may also run from places the index cannot follow."

**Anchoring (URL).** A new `trace=<node id>` view option in `router.ts` (`ViewOptions`, `hrefView`). While `trace` is set,
the Caller chain section shows the chain of `trace` rather than of `fn`, with a header "Callers of `<name>`" and a ×
to clear it. Opening a row writes `fn=<caller>` and keeps `trace`, using the existing scope rule (keep the scope when the
caller is in it, else switch to the caller's file). The reader can walk up the chain across files and come back.
Expansion state is held in component state keyed by `trace` and is not written to the URL.

**Find palette.** Function rows get a second action, **Callers**: Shift+Enter, or a small button on the active row. It
opens `hrefView(id, "flow", { scope: f.file, fn: f.id, trace: f.id })`. A hint under the list says "⇧↵ callers".
Duplicate short names are already told apart by `file:line`. Keep that, and show the qualified name as the label.

## Phases (each a dispatchable unit; edges are real dependencies)

| Phase | Work | Blocked by |
|---|---|---|
| **P0** Sizing probe (read-only) | Script over the insight index (~33k nodes) and the cognition index: fan-in distribution, BFS node count to depth 3/6/12 for the 20 highest fan-in functions and for `validatePhysicsModel`, BFS time per query. Output a table; pick `maxDepth` / `maxNodes` defaults and the hard max. | none |
| **P1** Model query | `refs-common.ts` extraction (refsOf unchanged), `callers.ts`, export from `packages/core/model/src/index.ts`, unit tests (below). Use the P0 numbers as defaults (placeholders 6 / 300 until then). | none (defaults patched after P0) |
| **P2** Payload + API + server parity | `callerGraphFor`, `getCallerGraph` in liveApi/staticApi (hosted via makeStaticApi), `/callers` route, parity tests. | P1 |
| **P3** Caller chain UI | Section, tree, toolbar, completeness note, CSS (rem tokens, both themes), React tests. | P2 |
| **P4** URL anchor + Find action | `trace=` option, chain survives navigation, Find Shift+Enter. | P3 |
| **P5** Browser verification | Test server on a free port (not 4317), index cognition, walk `validatePhysicsModel` to depth 6, screenshots for desktop and 390 px, light and dark, into `docs/screenshots/reverse-lookup/`. | P4 |
| **P6** (optional, separate go) Unresolved call edges | The TS frontend emits `calls.call` to `{unresolved: {scheme: "ts.call", text: callee}}` for unresolved callees. Measure the IR size growth on insight. The chain then adds "N unresolved calls named `<short name>`" as a name-match hint. Bump the frontend version. | P1 |

P0 and P1 can run in parallel. Each executor that edits gets its own worktree from `git -C ~/deploy/insight worktree add`
(not `isolation: "worktree"` from `/home/richard`). Use the gates
`pnpm -r --workspace-concurrency=1 build` and `pnpm -r --no-bail --workspace-concurrency=1 test`, run in the foreground. The known
`apps/hosted/test/auth.test.ts` refresh failure is pre-existing.

## Tests and acceptance criteria

**Model (P1), `packages/core/model/test/callers.test.ts`, built with `@insight/sdk/testing` fixtures as in `refs.test.ts`:**
- chain `A → B → target`: depths 0, 1, 2; edges B→target and A→B; no stop on A except `none`.
- diamond `A → B → T`, `A → C → T`: A is one node with depth 2 and two outgoing edges; `nodes` has no duplicate.
- self-recursion `T → T` and mutual `B → C → B → T`: `cycles` holds the groups, the closing edges have `back: true`, and the walk terminates.
- candidate caller: listed with `candidate: true` and `certainty: "possible"`; not expanded unless `possible`; with
  `possible`, its callers appear and stay `possible`, while a node also reachable exactly becomes `exact`.
- value reference: row tagged, the referenced node has `blind: ["value"]`; truncated candidate set → `blind: ["truncated"]`.
- anonymous caller folded into its owner, with a count, as in refsOf; spawn caller labelled `spawns worker`.
- module top-level caller: leaf with `stop: "module"`.
- `stayInScope`: an outside caller is listed with `stop: "outside-scope"` and not expanded.
- caps: `maxDepth: 1` gives `stop: "depth"` and `hidden` counts on depth-1 rows; `maxNodes: 3` gives `truncated.reason: "nodes"` and stable output.
- invariant: depth-1 callers equal `refsOf().calledBy`, on the fixture and on a real snapshot (insight or cognition `model.json`, if available in test data).
- determinism: two runs, and shuffled `doc.edges`, give deep-equal output.

**API (P2):** `modelParity.test.ts` gains a case: for three functions (leaf, hub, recursive), the live api, the demo api and
the `/callers` route return deep-equal payloads. Error parity for a bad scope and an unknown id. Route parsing clamps depth and nodes.

**UI (P3/P4), `apps/web/test/callerChain.test.tsx`:** starts collapsed; expanding shows depth-1 rows equal to "Called by";
expanding a row fetches nothing new (one graph per options set) and shows its callers; `↻` leaf for recursion; `also via`
on a diamond; `possible` rows styled apart and hidden from expansion until the toggle; the completeness note switches; keyboard
(↓ → ← Enter `*`) moves and expands as the tree pattern says; a row link keeps `trace=`; Find Shift+Enter writes `trace=`.

**Acceptance (P5, in a browser):** on cognition, select `validatePhysicsModel`. Caller chain lists every direct caller
(equal to "Called by"). Expand to depth 6 and every node is reachable. Open three callers in other files: the chain stays
anchored and the scope follows the existing rule. × clears it. Then confirm Find ⇧↵ on `validatePhysicsModel` opens the
same view. Screenshots committed.

## Decisions for the user

1. **Default caps.** Wait for P0. My guess is depth 6 and 300 nodes, with a hard max of 2000.
2. **Possible callers default off?** Recommended: off. Rows are still listed, and only expansion through them waits for the toggle.
3. **Section name.** "Caller chain" (alternatives: "Callers", "Call chain"). This avoids "review".
4. **P6 unresolved call edges.** This is a frontend and IR change that grows `model.json`. It needs its own go after P0 measures the cost.

## Risks

- Hub functions (logging, `assert`, `cmp`) have huge fan-in. The node cap plus "+N more" keeps them bounded, and P0 decides the defaults.
- Lambda folding is always on for callers, as in refsOf. With the Lambdas toggle on, the "Calls" list shows λ rows but the
  chain still never does. This is intended; say so in a tooltip.
- `model.json` from older exports lacks nothing this needs (relations come from edges), so no capture change is required.
- The hosted index can't resolve bare workspace imports without node_modules for non-insight repos. Their chains stop
  early, and the completeness note cannot detect that. This is the same limit as "Called by".
