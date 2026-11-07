# Scoped IR views

A scope is a part of a project that a lens can run on: a folder, a single file, or the whole
project. This page covers how a scope is cut from the IR, what a lens does with the cut, how
results are cached, and the two server routes that expose it.

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

## Server routes

Both routes are in `apps/server/src/app.ts`. They take `?path=<scope>`, and an optional
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

The checks run in this order: project, `path` presence and repetition, snapshot, scope path, lens.
So a bad path in a project with no snapshot gives the snapshot error.

## Limits

- The Web app does not use these routes yet.
- The routes do not paginate. A folder listing holds one row per loaded lens.
- A lens that errors on a scope is run again on each request, since only `ok` results are stored.
