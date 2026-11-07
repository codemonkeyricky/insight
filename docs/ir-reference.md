# IR reference

The IR is the only thing frontends and lenses share. It is JSON, described by JSON Schema, and stored as NDJSON: one record per line. Each record is one of:

- `{"node": IRNode}`
- `{"edge": IREdge}`
- `{"finding": IRFinding}`

The schemas live in `packages/ir/schema/`. `core.schema.json` holds the record shapes, `facets/<facet>.schema.json` holds the attribute schemas for each facet's base kinds, `core.kinds.json` declares the base kinds, and `kind-definition.schema.json` is the format for kinds declared by plugins.

## Records

**Node.** `id` (stable string), `facet`, `kind`, `attrs` (object), `provenance`, and optionally `parent` (containment: package > module > file > function > block) and `span`.

**Edge.** `from` (node id), `to`, `facet`, `kind`, `provenance`, and optionally `attrs` and `span`. `to` is one of:

- a node id string, for an exact target;
- `{"unresolved": {"scheme": "cpp.include", "text": "net/socket.h"}}`, for a reference a resolver must settle later;
- `{"candidates": ["id1", "id2"]}`, for an uncertain target such as a virtual call.

**Finding.** `severity` (`info`, `warning`, `error`), `message`, optionally `nodes`, `span` and `provenance`.

**Span.** `{"file": "app/billing.ts", "start": [line, column], "end": [line, column]}`. Lines and columns are zero-based.

**Provenance.** `{"frontend": "typescript", "confidence": "exact" | "inferred" | "heuristic"}`, optionally with `mode` (for example `tool-backed` or `static`) and `configuration` (the build configuration the fact belongs to).

Node IDs are chosen by the frontend. The convention is `<file>#<qualified name>`, with children appended, for example `app/billing.ts#charge/call/3`.

## Facets

Facets are optional and declared. A frontend lists the facets it fills, and a lens lists the facets it needs. `structure` is required from every frontend.

| Facet | Models |
|---|---|
| `structure` | Containment: package, module, file, namespace, type, function |
| `packaging` | Imports, exports, includes, build targets, dependency edges |
| `flow` | Control flow inside a function |
| `calls` | Who invokes whom |
| `concurrency` | Things that run alongside other things |
| `sync` | Coordination: locks, semaphores, atomics, condition variables |
| `effects` | Contact with the outside world: fs, net, process, env, clock |
| `x-*` | Open namespace for plugin facets |

## Kinds

A kind is named `<namespace>.<name>`. Core kinds use their facet as the namespace. Plugin kinds must use an `x-<name>.` namespace.

Each kind is declared by a definition with these fields:

- `kind`, `facet`, `on` (`"node"` or `"edge"`)
- `extends` (optional): the kind this one specialises. A query for the parent also returns this kind. Extension must stay in one facet and keep the same `on`.
- `attrs` (optional): a JSON Schema for the kind's own attributes. The effective schema is the combination of this schema and every ancestor's, so the parent's rules still apply. Attribute schemas are open, so extra fields are allowed.
- `composedOf` (optional): the parts a feature is made of, each with `role`, `kind` or `oneOf`, `many`, `optional` and nested `contains`.
- `description` (optional)

A node or edge whose kind has no definition is still stored and reported as **opaque** in the coverage view. It is not dropped.

Base kinds shipped by the core:

| Kind | Facet | On | Extends | Description |
|---|---|---|---|---|
| `structure.package` | structure | node | – | A package or project root. |
| `structure.module` | structure | node | – | A module (one import unit). |
| `structure.file` | structure | node | – | A source file. Created by discovery before any frontend runs. |
| `structure.namespace` | structure | node | – |  |
| `structure.type` | structure | node | – |  |
| `structure.function` | structure | node | – |  |
| `flow.block` | flow | node | – | A labelled region: the try, catch or finally part of a try, or a loop body. |
| `flow.branch` | flow | node | – | if / else, or any two-way choice. |
| `flow.branch-arm` | flow | node | – | One arm of a branch or switch: then, else, a case or the default. |
| `flow.switch` | flow | node | `flow.branch` |  |
| `flow.loop` | flow | node | – |  |
| `flow.try` | flow | node | – |  |
| `flow.throw` | flow | node | – | Raises an exception. |
| `flow.return` | flow | node | – | Leaves the enclosing function. |
| `flow.jump` | flow | node | – | break or continue: leaves or restarts the enclosing loop or switch. |
| `packaging.build-target` | packaging | node | – |  |
| `packaging.import` | packaging | edge | – |  |
| `packaging.export` | packaging | edge | – |  |
| `packaging.re-export` | packaging | edge | `packaging.export` |  |
| `packaging.include` | packaging | edge | – |  |
| `packaging.dep-edge` | packaging | edge | – | A build-level dependency between targets or packages. |
| `packaging.target-contains` | packaging | edge | – | A build target contains a file. |
| `calls.call-site` | calls | node | – |  |
| `calls.dynamic-dispatch` | calls | node | – |  |
| `calls.callback-registration` | calls | node | – |  |
| `calls.call` | calls | edge | – | Caller function to callee function. |
| `calls.contains-call` | calls | edge | – |  |
| `concurrency.spawn-thread` | concurrency | node | – |  |
| `concurrency.spawn-process` | concurrency | node | – |  |
| `concurrency.coroutine` | concurrency | node | – |  |
| `concurrency.async-task` | concurrency | node | – |  |
| `concurrency.await` | concurrency | node | – |  |
| `concurrency.channel-send` | concurrency | node | – |  |
| `concurrency.channel-recv` | concurrency | node | – |  |
| `concurrency.spawns` | concurrency | edge | – | Spawning function to the thing it starts. |
| `sync.lock-acquire` | sync | node | – |  |
| `sync.lock-release` | sync | node | – |  |
| `sync.rwlock-acquire` | sync | node | `sync.lock-acquire` |  |
| `sync.semaphore` | sync | node | – |  |
| `sync.atomic-op` | sync | node | – |  |
| `sync.condvar` | sync | node | – |  |
| `effects.fs.read` | effects | node | – |  |
| `effects.fs.write` | effects | node | – |  |
| `effects.net.connect` | effects | node | – |  |
| `effects.net.listen` | effects | node | – |  |
| `effects.proc.exec` | effects | node | – |  |
| `effects.env.read` | effects | node | – |  |
| `effects.clock.read` | effects | node | – |  |
| `effects.unknown` | effects | node | – | An external call no catalog recognises. Kept rather than dropped. |

## Writing a kind definition

A plugin supplies definitions in a JSON file named by the `kinds` field of its manifest, or in its frontend's `defines` list. For example, a Go `select` statement could be declared as:

```json
{
  "kind": "x-go.select",
  "facet": "flow",
  "on": "node",
  "extends": "flow.branch",
  "attrs": { "type": "object", "properties": { "hasDefault": { "type": "boolean" } } },
  "composedOf": [
    { "role": "case", "kind": "flow.branch-arm", "many": true,
      "contains": [{ "role": "guard", "oneOf": ["concurrency.channel-send", "concurrency.channel-recv"] }] }
  ]
}
```

Definitions from every plugin are merged into one registry. Each batch is checked as a whole. If any definition is invalid, the whole batch is rejected and the error names the plugin. Conflicts, missing parents and parent cycles are all reported with the plugin ids involved.

## Validating a file

`validateIR(text, registry)` from `@insight/ir` parses NDJSON, checks each record against the core schema, checks each node and edge against its kind (facet, role, attributes), and by default requires every parent and edge endpoint to exist inside the same document. The result lists each problem with its line number.

## Versioning

Plugins declare the IR format version they target in their manifest (`irVersion`), and the loader rejects a mismatch with a message. Individual facets are not versioned yet; that is future work.
