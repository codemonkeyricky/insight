# Insight

Insight is a design review tool for code an AI wrote. It reads a project, turns it into a
language-neutral graph (the **IR**), and runs **lenses** over that graph to show you its structure:
module dependencies and import cycles, call reachability, side effects, concurrency, lock order
and complexity. You review the findings in a local web app, record decisions, annotate code, and
compare two commits to see how the design changed.

Everything runs locally. Insight reads source files statically by default. Build tools such as
`bazel` or `cmake` run only if you pass `--allow-build-tools`.

## How it works

```
 project files ──► frontends ──► IR (NDJSON shards) ──► resolvers / linker ──► snapshot + SQLite index
                                                                                     │
                                                         lenses ◄────────────────────┘
                                                           │
                                       findings, graphs, tables ──► server ──► web app
```

- **Frontends** turn one language or build system into IR records (nodes, edges, findings). Each
  one declares which *facets* it fills: `structure`, `packaging`, `flow`, `calls`, `concurrency`,
  `sync`, `effects`.
- **Resolvers** settle references a frontend left unresolved, for example a C++ `#include` that
  needs the include directories of a build target.
- **Lenses** read the IR through a read-only `IRView` and report findings and views. A lens whose
  required facets no frontend provides is reported as `unavailable` and does not run.
- **Incremental indexing.** Files are hashed into a Merkle tree, so a re-index only re-extracts
  changed files and reuses cached shards. A lens is not run again when its inputs have not changed.

State for each indexed project lives in `<project>/.insight/`: shards, snapshots, `index.sqlite`,
lens results, lens configuration, review decisions and annotations.

## What's included

| Package | What it does |
|---|---|
| `packages/ir` | JSON Schemas, generated TypeScript types, kind registry and validator for the IR |
| `packages/sdk` | `Frontend`, `Lens` and `Resolver` interfaces, `IRView`, trace helper, conformance kit |
| `packages/core` | Plugin loader, change detection, shards, snapshots, linker, pipeline, SQLite index, snapshot diff, commit comparison, review and annotations |
| `packages/cli` | The `insight` command |
| `apps/server` | Local Fastify server: project registry, indexing jobs with SSE progress, read API |
| `apps/web` | React + Cytoscape web app: projects, overview, lens pages, compare, review |

Frontends:

| Plugin | Reads | Facets |
|---|---|---|
| `frontend-typescript` | TypeScript and JavaScript, via the TypeScript compiler API | structure, packaging, calls, flow, concurrency, effects |
| `frontend-cpp` | C and C++, via tree-sitter (syntactic) | structure, packaging, calls, flow, concurrency, sync, effects |
| `frontend-bazel` | Bazel `BUILD` files, read statically | packaging |
| `plugins/frontend-cmake` | `CMakeLists.txt`, read statically; also resolves C++ includes through target include dirs | packaging |

Lenses:

| Lens | Reports |
|---|---|
| `lens-dependencies` | Module graph, import cycles, and layer rules you configure |
| `lens-calls` | Reachability from entry points, unreachable functions, recursion |
| `lens-effects` | Side effects per function, effects reachable from entry points, forbid rules by module |
| `lens-concurrency-map` | Async tasks, awaits, and thread or process spawns per function |
| `lens-lock-order` | Lock acquisition order across calls, and cycles in it |
| `lens-flow-complexity` | Cyclomatic complexity per function |

## Requirements

- Node.js 22 or later (see `.nvmrc`)
- pnpm 10
- git, if you want to index git URLs or compare commits

## Getting started

```sh
pnpm install
pnpm build
```

### Index a project from the command line

```sh
node packages/cli/dist/cli.js index <path> [--full] [--allow-build-tools] [--json] [--quiet]
```

| Option | Effect |
|---|---|
| `--full` | Ignore cached shards and re-extract every file |
| `--allow-build-tools` | Let frontends run build tools such as `bazel` or `cmake` (off by default) |
| `--json` | Print the run report as JSON, including each lens's status and finding count |
| `--quiet` | Do not print progress lines |

The command writes its output to `<path>/.insight/` and prints a report with file counts, graph
size, per-facet coverage and skipped frontends. It exits with `1` if the run hit problems.

Try it on the bundled lock-order fixture:

```sh
node packages/cli/dist/cli.js index samples/lock-order-fixture
```

### Run the web app

`pnpm build` also builds the web app, and the server serves it:

```sh
node apps/server/dist/main.js
# Insight server on http://127.0.0.1:4317
```

Open <http://127.0.0.1:4317>, add a local folder or a git URL, and Insight indexes it in the
background. From a project you can open each lens, see the source behind a finding, compare two
commits, annotate nodes and findings, and work through the review checklist (mark findings
accepted or dismissed).

Server settings:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4317` | Port to listen on |
| `HOST` | `127.0.0.1` | Address to bind |
| `INSIGHT_HOME` | `~/.insight` | Where the project registry and git clones are kept |

For web development with hot reload, run the server as above and start Vite in another terminal:

```sh
pnpm --filter @insight/web dev    # http://localhost:5173, proxies /api to the server
```

Set `INSIGHT_API` if the server is not at `http://127.0.0.1:4317`.

## Configuring lenses

Lens settings live in `<project>/.insight/lenses/<lens-id>.json`. For example, layer rules for the
dependencies lens:

```json
{
  "rules": [
    { "from": "src/ui/**", "notDependOn": ["src/db/**"], "reason": "UI goes through the service layer" }
  ]
}
```

and entry points plus forbidden effects for the effects lens (`lens-effects.json`):

```json
{
  "entries": ["src/main.ts#main"],
  "forbid": [
    { "module": "src/domain/**", "effects": ["fs.write", "net"], "reason": "domain code stays pure" }
  ]
}
```

`lens-calls` also takes `entries`. Without them, lenses that need entry points start from the
functions the frontend marks as exported.

## Extending Insight

Frontends and lenses are plugins: any folder with an `insight-plugin.json`. The loader looks in
`packages/*` and `plugins/*` in this repository, in `~/.insight/plugins`, and in
`.insight/plugins` inside the project being indexed. A plugin that fails a check is disabled with
a reason, and the rest still run.

- [docs/ir-reference.md](docs/ir-reference.md): records, facets and kinds
- [docs/writing-a-frontend.md](docs/writing-a-frontend.md): the `Frontend` contract, manifests, resolvers, testing
- [docs/writing-a-lens.md](docs/writing-a-lens.md): the `Lens` contract, `IRView`, ordering, reuse

## Samples

`samples/` holds an unmodified copy of [google/benchmark](https://github.com/google/benchmark) used
as the C++ / Bazel / CMake sample, and a small hand-written fixture for the lock-order lens. See
[samples/README.md](samples/README.md) for the pinned commit and measured results, including the
current limits of static mode on real code.

## Development

```sh
pnpm build       # build every package
pnpm test        # run every package's vitest suite
pnpm typecheck   # type-check without emitting
```

Run one package's tests with `pnpm --filter <package-name> test`, for example
`pnpm --filter @insight/core test`. IR types in `packages/ir/src/generated` come from the JSON
Schemas; regenerate them with `pnpm --filter @insight/ir gen` after editing a schema.

## License

MIT, as declared in each `package.json`. There is no separate LICENSE file yet. The vendored
`samples/benchmark` copy keeps its own Apache-2.0 license.
