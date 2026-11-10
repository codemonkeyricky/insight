# Scoped IR views

A scope is a part of a project that a lens can run on: a folder, a single file, or the whole
project. This page covers how a scope is cut from the IR, what a lens does with the cut, how
results are cached, how a folder's calls resolve, and the server routes that expose it.

Scoped views are read-only. They never change the IR, the project's stored analysis, or the
project format.

## Hierarchy

A project has three levels of scope:

| Scope    | Path example | Holds                                                         |
|----------|--------------|---------------------------------------------------------------|
| project  | `""`         | every node, edge and finding in the snapshot                  |
| folder   | `src/core`   | every node whose file lies under that folder                  |
| file     | `src/a.ts`   | every node whose file is exactly that file                    |

A scope is a project-relative path. Folders are not IR nodes. A folder scope matches by whole path
segments, so `src` holds `src/a.ts` but not `src2/a.ts`.

A node belongs to a file when:

1. it has a `span`, and the span's file is the file;
2. or it is a `structure.file` node, and its path (`attrs.path`, or its id) is the file;
3. or it has no span of its own, and its parent chain reaches a node with one of the above.

A node with no file at all (for example some packaging nodes) is local to the project scope only.

Scope strings are checked by `normalizeScope` in `packages/core/src/scope.ts`. Backslashes become
forward slashes, `.` and empty segments are dropped, and a trailing slash is removed. An absolute
path, or any `..` segment, is refused with an input error.

## Scoped IR

`scopeDoc(doc, scope, opts)` returns `{ doc, stats }`. The root scope returns the document
unchanged. For any other scope:

- A node is kept when it belongs to the scope. A kept node whose parent was dropped has its
  `parent` removed.
- An edge is kept when either end is in the scope. An edge with neither end in scope is dropped.
- A finding is kept when its span's file is in scope. A finding with no span is kept when one of
  its nodes is in scope.
- Ids are never rewritten. An id names the same node in every scope.

### Stub design

An edge that leaves the scope still points at a real node. Its far end becomes a stub:

```json
{
  "id": "lib/c.ts#c",
  "facet": "structure",
  "kind": "structure.function",
  "attrs": { "name": "c", "exported": true, "external": true },
  "provenance": { "frontend": "scope", "confidence": "exact" }
}
```

A stub keeps the id, facet, kind and attributes of the original node. It adds `external: true`
and has no `span` and no `parent`. Its provenance says it was made by the scope cut.

Other rules that follow from this:

- Edges with no end in scope are dropped, so an edge set made only of outside nodes cannot
  form a cycle inside a scope.
- A candidate set (an edge whose target is one of several possible nodes) keeps every member,
  and the members outside the scope are stubbed.
- An unresolved target is kept as it is.
- Stubs are endpoints only. Lenses never list them, and they never count toward findings or
  metrics. `isExternal(node)` from `@insight/sdk` is the test for a stub.
- `stats.nodes` and `stats.external` are counted separately. `stats.external` is the number of
  stubs.
- `scopeFacets(doc)` lists the facets a scope has facts in. Stubs do not count toward a facet,
  but an edge does, even when its far end is outside the scope.

A stub's module, for `lens-dependencies`, is the part of its id before `#`.

## Lens degradation

A lens runs on a scope the same way it runs on the project, with two changes: it sees the scoped
document, and it can be given a `scope` in its context. Lenses degrade as follows.

| Situation                                         | Result                                                                 |
|---------------------------------------------------|------------------------------------------------------------------------|
| A required facet has no facts in the scope        | `status: "unavailable"` with a `reason` that names the scope and facet. Not run, not stored. |
| The lens throws                                   | `status: "error"` with the message as `reason`. Not stored.            |
| An optional facet is missing                      | The lens runs without it.                                              |

Lens-specific behaviour on a partial scope:

- **lens-execution.** When the scope has no spawn nodes, it shows a function tree (`mode:
  "functions"`, from `executionTree`). With neither spawns nor functions it shows an empty state:
  label "Nothing to show", kind `empty`.
- **lens-calls.** Reachability has four statuses: `entry`, `reachable`, `called from outside`
  and `unreachable`. A function that an outside caller can reach is `called from outside`, not
  `unreachable`, and it is not counted in the `unreachable` metric. A configured entry outside the
  scope is ignored silently. A configured entry that names a missing function inside the scope
  gives a warning finding.
- **lens-dependencies.** Outside modules are grouped as `(outside scope)`. The `modules` metric
  counts local modules only. `externalModules` counts the outside ones.
- **lens-concurrency-map, lens-lock-order, lens-effects, lens-flow-complexity.** Stubs are skipped
  in their lists, findings and metrics.

Lens ids and the project format are unchanged. The output of lens-execution (on a project with
no spawns) and of lens-dependencies (the `modules` and `externalModules` metrics) did change.

## Caching

`runLensOnScope` (in `packages/core/src/scoped-analysis.ts`) runs one lens on one scope. It first
runs the lenses named in the target's `after` list, each through the same cache.

Only `ok` results are stored, under the project's analysis folder:

```
.insight/analysis/scopes/<snapshot>/<sha256(scope)[0:32]>__<lensId>__<inputsHash[0:32]>.json
```

- `inputsHash` is `sha256` of the canonical JSON of `{ id, version, scope, config, facets,
  nodes, edges }`. The `nodes` and `edges` are the scoped document's nodes and edges for the
  lens's required and optional facets, stubs included. `config` is the lens's settings file.
- A stored file is read only when its `inputsHash` matches. A match gives `reused: true`.
- Files are written atomically. Each file has a `schema` field, `SCOPED_SCHEMA = 1`. A file with
  another schema is ignored and computed again.
- The root scope `""` returns the project's stored record for that lens when it exists. It does
  not write a scope file.

The listing does not check `inputsHash`. For each lens it shows the newest stored file for the
scope and snapshot, by file time. Within one snapshot the inputs are fixed, so the listing is only
out of date after a lens setting or lens version changes and the lens has not been run again.
A run always checks the hash.

## Flow and call resolution by scope

`summarizeScope(nodes, edges, scopeFiles)` in `packages/flow/src/scope.ts` turns a scope's cut
document into its call flow. It is pure: it reads the nodes and edges that `scopeDoc` keeps and
returns plain data, with nothing laid out. The server passes `scopeFiles`, the scope's
`structure.file` nodes that are not stubs.

Each `calls.call` edge whose caller is in the scope is one call. Its target is resolved against the
scope:

| Outcome      | When                                                                              |
|--------------|-----------------------------------------------------------------------------------|
| `resolved`   | the target is a function in the scope                                             |
| `external`   | the target is outside the scope (a stub), so it resolves in a wider scope         |
| `unresolved` | the IR names no target for the call                                               |

A call with a candidate set (one of several possible targets) is `resolved` when any candidate is a
function in the scope. Each candidate gets its own row, with `candidate: true`.

A call from outside the scope into a function in it is `inbound`. It is not counted in `calls`. It
marks the function `calledFromOutside`, and such a function is never an entry.

Resolution only widens. A call that is `external` in a file is `resolved` in the folder that holds
its callee, and stays `resolved` in every scope above that folder. In every scope,
`resolved + external + unresolved` equals `calls`.

Granularity:

- At most `SCOPE_FUNCTION_LIMIT` (400) functions gives `"functions"`. Each function is a row, and
  each caller and callee pair is a row in `calls`.
- More than 400 gives `"files"`. `functions` is empty, `calls` is aggregated per pair of files
  (calls within one file are dropped), and each outside file is one external whose `id` is its
  path.

Entries are the roots of the call graph: the functions (or, in `files` granularity, the files) with
no caller or referrer in the scope and no caller or referrer outside it. A referrer is a
`calls.reference` edge (see below).

Module-level code, meaning statements that run when a module loads, is not a function row. Its calls
have the file path as `from`, and its counts go to the file's row in `files`.

`stats.files` counts every file of the scope. The linker gives each project file a `structure.file`
node, so files with no functions count too. `files` lists only the files with functions or
module-level code.

## Project model

One snapshot has one whole-project model, `buildProjectModel(doc)` in `packages/model` (`@insight/model`).
It is pure TypeScript with no `node:` imports, and it depends only on `@insight/ir` and `@insight/sdk`. The
server builds it once per loaded snapshot (`LoadedSnapshot.model`, built on first use). A scope is a view of
that model, not a cut that is recomputed per request.

- `doc` is the original IRDocument, untouched. Lenses still read it.
- `byId` and `fileOf(id)` give each node's file through its parent chain (the same rules as `scopeOfNode`).
- `tree` holds a folder entity per directory: id `dir:<path>`, the root `dir:`, sorted child folders and
  files, and subtree counts of files and functions.
- `functions` lists every `structure.function` node with its file and whether it is anonymous.
- `relations` normalizes four edge kinds into `{ kind, from, to, how?, candidate, edge }`: `calls.call` (call),
  `calls.reference` (reference), `concurrency.dispatches` (dispatch) and `concurrency.spawns` (spawn). A candidate
  set gives one relation per candidate, with `candidate: true`. Unresolved targets give no relation.
- `out` indexes relations by `from`, and `in` by `to`. `in` is the reverse-reference index: who calls or references
  a function.

A scope is a view of the model: `scopeView(model, scope)` (`packages/model/src/view.ts`) returns
- `kind`: `project`, `folder` or `file`, and `has(id)`, which tells whether a node is in the scope;
- `files()` and `functions()`, the scope's files and functions;
- `callers(id)` and `callees(id)`, the relations into and out of `id` across the whole project. Each one carries
  `inScope`, which says whether the other end is in the view. A project-wide "called by" list is `callers` in the
  root view, and in a folder view it splits into "in this scope" and "outside this scope";
- `toDoc(opts)`, the scoped IR with the same stub and finding rules as before. `scopeDoc` in `@insight/core` is
  now `scopeView(buildProjectModel(doc), scope).toDoc(opts)`, and its tests are unchanged.

For example, with `src/a.ts` (function `a`) calling `lib/b.ts` (function `b`): in view `src`,
`callees(a)` gives `b` with `inScope: false`; in view `lib`, `callers(b)` gives `a` with `inScope: false`; in the
root view both are `inScope: true`.

`normalizeScope` and `inScope` live in the model. Core re-exports them, and maps a bad scope to its `InputError`
(400), so the route behavior is unchanged.

### Serialized model and client-side views

`serializeModel(model, snapshot)` and `loadModel(json)` (`packages/model/src/serialize.ts`) move the model
across the wire. The file is `{ schema, snapshot, doc: { nodes, edges, findings } }` with `schema` set to
`MODEL_SCHEMA` (1). The IR document is the source of truth, so the file holds no derived index: `loadModel`
checks the schema and calls `buildProjectModel` again. A different schema number, or a missing `doc` array, throws.

The browser builds each scope's views from this model, so a scope change needs no request:

- `apps/web/src/model/store.ts` (`models`, a `ModelStore`) fetches the model once per project, builds it, and keeps
  it. A key loaded from one snapshot is dropped when the latest overview names another. A failed load is not kept.
- `apps/web/src/model/payloads.ts` (`scopeFlowFor`, `scopeExecFor`) answers the same payloads as `/scope/flow` and
  `/scope/exec`. They run `summarizeScope` on `scopeView(model, scope).toDoc()` with the scope's files, and
  `execModel` on the whole document, as `scopeFlowOf` and `scopeExecOf` do in `apps/server/src/reader.ts`.
  The extra fields (`snapshot`, `scope`, `kind`) are the same too. The module has no browser globals, so the
  demo capture (`scripts/capture-demo.mjs`) runs it under Node.
- `liveApi` (`apps/web/src/api.ts`) and `staticApi` (`apps/web/src/staticApi.ts`) call those functions for
  `scopeFlow` and `getScopeExec`. The live app reads `GET /api/projects/:id/model`. The demo reads `model.json`.
- `apps/web/test/modelParity.test.ts` indexes this repository, and checks that both APIs return the server's JSON
  for the root, a folder and a file, and that the live API fetches the model once.

The server keeps the scope routes for other clients. Lens results and the exec layouts stay per scope.

## Server routes

The routes are in `apps/server/src/app.ts`. They take `?path=<scope>`, and an optional
`?snapshot=<id>` (the default is the project's latest snapshot). The `path` parameter must be given
exactly once. An empty value (`?path=`) is the project scope.

### List the lenses for a scope

`GET /api/projects/:id/scope/lenses?path=<scope>`

The default snapshot is the project's latest. `?snapshot=<id>` picks another one.

```json
{
  "snapshot": "<snapshot id>",
  "scope": "src",
  "kind": "folder",
  "stats": { "nodes": 12, "edges": 9, "findings": 1, "external": 2 },
  "facets": ["calls", "structure"],
  "lenses": [
    { "id": "lens-dependencies", "title": "Dependencies", "status": "ok", "findings": 1 },
    { "id": "lens-effects", "title": "Effects", "status": "unavailable", "reason": "unavailable: scope \"src\" has no effects facts", "findings": null },
    { "id": "lens-calls", "title": "Calls", "status": "not-run", "findings": null }
  ]
}
```

The numbers and facet names above are an example. `kind` is `"project"`, `"folder"` or `"file"`.
`status` is `"ok"`, `"unavailable"`, `"error"` or `"not-run"`. `"not-run"` means no stored result
exists for the scope. Scope listings do not store `error` results, so `"error"` appears only for
the project scope.

### Run one lens on a scope

`GET /api/projects/:id/scope/lenses/:lensId?path=<scope>`

```json
{
  "snapshot": "<snapshot id>",
  "scope": "src",
  "kind": "folder",
  "lens": {
    "id": "lens-dependencies",
    "title": "Dependencies",
    "status": "ok",
    "reused": false,
    "inputsHash": "<64 hex characters>",
    "result": { "findings": [], "views": [], "metrics": {} }
  }
}
```

`lens` is a `LensRecord`: `status`, `reason` (for `unavailable` and `error`), `reused`,
`inputsHash`, and `result` (for `ok`) with `findings`, `views` and `metrics`.

### Call flow of a scope

`GET /api/projects/:id/scope/flow?path=<scope>`

The `ScopeFlow` of the scope, with `snapshot`, `scope` and `kind` in front. The values below are an
example. The shape is exact.

```json
{
  "snapshot": "<snapshot id>",
  "scope": "src",
  "kind": "folder",
  "granularity": "functions",
  "functions": [
    {
      "id": "src/a.ts#a", "name": "a", "file": "src/a.ts", "async": false,
      "span": { "file": "src/a.ts", "start": [2, 0], "end": [4, 1] }, "line": 3,
      "steps": 2, "decisions": 0, "loops": 0, "tries": 0,
      "awaits": 0, "spawns": 0, "effects": 0, "exits": 1, "calledFromOutside": true
    }
  ],
  "calls": [{ "from": "src/a.ts#a", "to": "lib/c.ts#c", "count": 1, "external": true }],
  "externals": [{ "id": "lib/c.ts#c", "name": "c", "file": "lib/c.ts" }],
  "entries": ["src/b.ts#d"],
  "unreferenced": [
    {
      "id": "src/b.ts#d", "name": "d", "file": "src/b.ts", "async": false,
      "span": { "file": "src/b.ts", "start": [4, 0], "end": [4, 22] }, "line": 5,
      "steps": 1, "decisions": 0, "loops": 0, "tries": 0,
      "awaits": 0, "spawns": 0, "effects": 0, "exits": 1, "reach": 2
    }
  ],
  "files": [{ "file": "src/a.ts", "functions": 1, "decisions": 0, "loops": 0, "tries": 0, "calledFromOutside": true }],
  "stats": {
    "functions": 4, "files": 5, "calls": 3, "resolved": 2, "external": 1, "unresolved": 0, "inbound": 0, "entries": 1,
    "functionsTotal": 4, "functionsNoise": 0, "unreferenced": 1, "unreferencedNoise": 0, "unreferencedOutside": 0
  }
}
```

`functions` is empty in `files` granularity. `calledFromOutside` appears only when it is true. A
`span` is `{ file, start: [line, column], end: [line, column] }`, with 0-based positions.

`unreferenced` lists the functions that no function in the scope calls or refers to, at either
granularity. It is the entry set of the scope's Flow view. A function is unreferenced in a scope `S`
when no function inside `S` calls it or refers to it:

- Calls are the `calls.call` edges, resolved the way `calls` resolves them. A call with several
  possible targets references each candidate.
- References are the `calls.reference` edges that the TypeScript frontend records for a function
  used without a call: constructed with `new` (its constructor), rendered as a JSX element, or used
  as a value, such as a callback, an exported name read through an import, or a decorator. A
  reference is not a call row, so it never appears in `calls`.
- A self-call or self-reference does not count. Module-level code in a file in `S` counts as a
  caller or referrer.
- A caller outside `S` does not count. Such a function is still unreferenced and is flagged with
  `calledFromOutside`; it resolves when the scope widens.
- `reach` is the number of distinct functions it reaches through calls and references inside `S`,
  not counting itself. Cycles are safe.
- A function defined in a noise file is marked `noise: true`. Noise files are the test, fixture and
  sample files: a directory named `test`, `tests`, `__tests__`, `fixtures`, `sample` or `samples` on
  the path, or a file named `*.test.*` or `*.spec.*`. Nothing in the code calls them: a test runner,
  a fixture loader or a reader does. A file named `sample.ts` is not noise, only a directory is.
  The stats count them apart. `unreferenced` and `unreferencedOutside` leave them out,
  `unreferencedNoise` counts them, `functionsTotal` counts all functions, `functionsNoise` counts
  the noise ones, and `functionsNonNoise` is the rest.
- An anonymous function (a function expression, arrow function or lambda with no declaration of its own)
  is never listed, and never an entry. Its calls and references count as those of its `parent`, the
  function or file it is written in. A named function that a lambda calls therefore has the same row
  identity and `reach` as when that call is written in its own body. The body measures (`steps`,
  `decisions` and the rest) count in the lambda, since it is its own function.

Widening a scope can only remove functions from the unreferenced set: a function unreferenced in a
wider scope is unreferenced in every narrower scope that holds it, because each caller inside the
narrower scope is also inside the wider one. The count for a scope can still rise when the scope
widens, because the wider scope holds more functions. `entries` follows the same rule, so a referenced
function is never an entry.

The result is kept in memory for up to 32 scopes, keyed by snapshot and scope. A snapshot does not
change, so a kept result is never stale. The errors are the same as the lens routes.

### Execution model of a scope

`GET /api/projects/:id/scope/exec?path=<scope>`

The `ExecModel` of the scope, with `snapshot` and `kind` in front. `execModel` in
`packages/flow/src/exec-model.ts` computes it from the calls, references, spawns and dispatches the
flow view reads. The shape is exact. The values are the `src` folder of the route test's fixture,
which has no spawns, and `functions` is in the order the threads list them.

```json
{
  "snapshot": "<snapshot id>",
  "kind": "folder",
  "scope": "src",
  "truncated": false,
  "functions": [
    { "id": "src/b.ts#d", "name": "d", "file": "src/b.ts", "line": 5, "inScope": true, "runtime": "thread" },
    { "id": "lib/c.ts#c", "name": "c", "file": "lib/c.ts", "line": 1, "inScope": false, "runtime": "thread" },
    { "id": "src/a.ts#a", "name": "a", "file": "src/a.ts", "line": 3, "inScope": true, "runtime": "thread" },
    { "id": "src/b.ts#b", "name": "b", "file": "src/b.ts", "line": 2, "inScope": true, "runtime": "thread" }
  ],
  "threads": [
    {
      "id": "main", "kind": "main",
      "roots": ["src/b.ts#d"],
      "reach": 4,
      "reached": ["lib/c.ts#c", "src/a.ts#a", "src/b.ts#b", "src/b.ts#d"],
      "coroutines": []
    }
  ],
  "dispatches": [],
  "stats": {
    "threads": 1, "spawns": 0, "resolved": 0, "outside": 0, "unresolved": 0, "candidates": 0,
    "coroutines": 0, "dispatches": 0,
    "functionsInScope": 3, "functionsThreaded": 3, "functionsCoroutineOnly": 0, "functionsUnthreaded": 0, "functionsListed": 4
  }
}
```

- **Threads.** The `main` thread starts at the in-scope functions that no in-scope caller references.
  A function is referenced when an in-scope function or file calls it, refers to it, dispatches to it
  or spawns it. A caller outside the scope does not count. Module-level code is a file, so a function
  that module-level code calls is referenced and starts no thread. A caller in a test, fixture or sample
  file counts only when the scope is such a folder. Each spawn node in scope starts one thread after
  `main`, sorted by spawn id, whether or not the spawn resolves. Its `kind` is the spawn's `how`:
  `thread`, `process` or `async`.
- **Anonymous functions.** An anonymous function is never a main root. Whatever runs it is its creator,
  a spawn or a dispatch. A lambda that a spawn starts runs on its own thread, and one that an `await` or
  `start` dispatch starts is a coroutine. Its `parent` is the function or file it is written in.
- **Roots and status.** A spawn's roots are its targets. A function target is a root. A script file
  target, such as a worker's file, has the functions its top-level code calls as roots, and `spawn.script`
  names it. A spawn with several targets has all of them as roots and sets `candidates`. The status is
  `resolved` when a root lies in scope, `outside` when it has roots and all of them lie outside the
  scope, and `unresolved` when it has none. An `outside` thread keeps its out-of-scope roots, so it still
  shows what the spawn runs.
- **Reach.** `reach` is the number of distinct functions a thread runs by calls, references and
  dispatches, roots included. A closure is a `calls.reference` with `how: "closure"`, from a function to
  an anonymous function it creates, so the creator runs what the closure calls. A closure that is a spawn
  or dispatch target is left out of its creator's reach. Reach does not follow spawns, since those start
  other threads. Reach follows the whole graph, so it can leave the scope. `reached` lists the same
  functions sorted by id.
- **Runtime.** Each function entry has `runtime`. `thread` means a thread runs it on its own, through
  calls, closures, references, or a `callback`, `timer` or `microtask` dispatch. `coroutine` means only an
  `await` or `start` coroutine runs it. `none` means no thread reaches it, as with a function only
  module-level code calls. The `functions` table names only the functions the model reaches: those in a
  thread's roots or reach, its coroutines, and the targets of the dispatches in scope.
- **Coroutines.** Each `await` or `start` dispatch that a thread reaches starts a coroutine, listed once
  per thread. Its `callees` are the functions it reaches by calls, without the coroutines it awaits,
  which are nested through `parent`. A cycle of awaits is cut where it repeats. `dispatchedBy` lists
  every function or file that starts the coroutine. `callback`, `timer` and `microtask` dispatches run on
  the dispatching thread, so they are not coroutines. A `message` dispatch (a Web Worker postMessage) runs its
  handler on the other side's thread, so it is not a coroutine either. The TypeScript frontend emits `.then` as `callback`.
- **Dispatches.** The flat list holds each dispatch whose source is in scope, in a fixed order. `from` is
  the function, or the file for module-level code, that dispatches. `file` and `line` are the site.
- **Stats.** `functionsInScope` counts the functions whose file lies in scope, anonymous ones included.
  `functionsThreaded` counts those some thread runs, coroutines included. `functionsCoroutineOnly` counts
  those only a coroutine runs, a part of `functionsThreaded`. `functionsUnthreaded` is the rest.
  `functionsListed` is the size of the `functions` table.
- **Order.** The result does not depend on the order of the edges they arrive in. Edges are sorted by
  content first, and threads, roots and `reached` are sorted by id.
- **Cap.** At most `MAX_EXEC_FUNCTIONS` (2000) distinct functions are listed. Past that, later functions
  are dropped, the lists are cut and `truncated` is `true`. `reach` stays exact. No scope of this
  repository reaches the cap.
- **Widening.** A function that is a main root of a wider scope is a main root of every narrower scope
  that holds it. Each spawn thread is the same in every scope that holds its spawn, with the same roots,
  reach and coroutines. The narrower scope's function and spawn counts are never larger than the wider's.
  A function on a thread in a narrower scope is on a thread or a coroutine in every wider scope, except
  test code seen from a project, which is no root there. Two cases break that, and tests pin both: a
  function only a wider scope's module-level code calls, and a function whose only wider-scope caller sits
  in a cycle that nothing roots. Adding a caller makes a function referenced, and a caller that starts no
  thread gives it none back. A function on no thread in a narrower scope can run on one in a wider scope,
  but only through a thread or a root the wider scope adds.

Module-level code does not start a thread. A function that only top-level code calls, such as a script's
`main()` at the bottom of the file, or a React component tree rendered from a module-level `render` call,
is in no thread, and neither is anything only it reaches. They are counted in `functionsUnthreaded`. `functions`
lists one only when a dispatch names it, and then with `runtime: "none"`. Test, fixture and sample functions are not roots of a project or folder scope
that is not itself test, fixture or sample code. They are roots of a scope that is, so their threads
show in that scope.

The result is kept in memory for up to 32 scopes, keyed by snapshot and scope. The errors are the same as
the call flow route, which is the table below.

### Whole-project model

`GET /api/projects/:id/model`, with an optional `?snapshot=<id>`

The serialized model of the snapshot (see "Serialized model and client-side views" above). It takes no `path`. The
checks are the scope routes': an unknown project, `project has no snapshot yet`, and `unknown snapshot <id>`. The
model covers the whole snapshot, so the same response serves every scope.

### Reverse references of a node

`GET /api/projects/:id/refs?id=<node>&path=<scope>&snapshot=<id>` lists what refers to a node and what it
refers to. The result is `{ "snapshot", "scope", "kind", "id", "calledBy": RefRow[], "calls": RefRow[] }`.
`calledBy` holds the nodes with a relation into `id`, and `calls` the nodes `id` has a relation to. It is
computed by `refsOf` in `packages/model/src/refs.ts` from the project model, not from the scope's cut, so
callers outside the scope are listed.

Each row has `id`, `name`, `file`, `line`, `isFunction`, `kind`, `candidate`, `count`, `inScope`, and `how`
when the relation has one:

- Anonymous functions are attributed to the nearest named function, or to their file when none encloses
  them. A callback written inside `a` that calls `b` is a call from `a`.
- Rows collapse by the other node and the relation kind. `count` is the number of call sites. `candidate`
  is true only when every relation is a candidate (see `edgeTargets` in `@insight/sdk`).
- For a function row, `file` and `line` are its definition. For a file row, `line` is the earliest call site.
- Rows are ordered in-scope first, then by file, line, name, id and kind.
- `inScope` says whether the other node is inside the scope. The Web app uses it to split the rows into
  "In this scope" and "Outside this scope", and an outside row switches the scope to its file.

The Web app does not fetch this route. `refsFor` in `apps/web/src/model/payloads.ts` computes the same
result from the ModelStore, and the parity tests check that the two agree. Project-wide function callers
also feed `ExecIndex.callers` in `apps/web/src/zoom/execMap.ts`. A caller outside the scope has
`runtime: "none"`.

### Errors

Errors are `{ "error": "<message>" }`.

| Status | Message                       | Cause                                                             |
|--------|-------------------------------|-------------------------------------------------------------------|
| 400    | `path is required`            | `path` is missing                                                  |
| 400    | `path must be given once`     | `path` is repeated                                                 |
| 400    | `scope must not leave the project: <path>` | the path has a `..` segment                   |
| 400    | `scope must be relative to the project: <path>` | the path is absolute                     |
| 404    | `no project <id>`             | the project id is unknown                                          |
| 404    | `project has no snapshot yet` | the project has not been indexed                                   |
| 404    | `unknown snapshot <id>`       | `?snapshot=` names a snapshot the project does not have            |
| 404    | `no such scope`               | no indexed file is at the path or under it                         |
| 404    | `no lens <id>`                | the lens id is not loaded                                          |
| 400    | `id is required`              | the refs route has no `id`                                         |
| 404    | `no node <id>`                | the refs route: the node id is not in the snapshot                 |

The checks run in this order: project, `path` presence and repetition, snapshot, scope path, lens.
So a bad path in a project with no snapshot gives the snapshot error.
The refs route checks project, `path`, `id`, snapshot, scope path, then the node.

## Limits

- The Web app calls these routes through `liveApi` in `apps/web/src/api.ts`. The demo build reads
  the same data from captured files under `scope/<key>/` (see `scripts/capture-demo.mjs`):
  `lenses.json`, `<lensId>.json`, and `exec-layout.json` (the laid-out exec scene, for a scope with at least one
  function). The demo writes one `model.json` for the whole project. The browser computes each scope's flow and exec
  from it (see "Serialized model and client-side views"), so the demo writes no per-scope `flow.json` or `exec.json`.
  The root key is `@root`.
- The demo holds one project and its id is random on every capture, so `staticApi` ignores the id in
  the URL. A link from an earlier deploy keeps working.
- The routes do not paginate. A folder listing holds one row per loaded lens.
- A lens that errors on a scope is run again on each request, since only `ok` results are stored.
