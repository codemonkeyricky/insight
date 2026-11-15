# Writing a frontend

A frontend turns one language or build system into IR (see [ir-reference.md](ir-reference.md)). It declares which facets it fills, reads project files, and emits NDJSON-shaped records. It never imports a lens, and lenses never see parser objects.

The contract is the `Frontend` interface in `packages/core/sdk/src/types.ts`:

```ts
interface Frontend {
  id: string;
  version: string;
  provides: FacetId[];
  defines?: KindDefinition[];                 // kinds this frontend adds to the registry
  detect(root: ProjectRoot): Promise<Detection | null>;
  extract(ctx: ExtractContext): AsyncIterable<IRBatch>;
  apiDigest?(relPath: string, text: string): string;
}
```

## Where it lives

Frontends are plugins. The loader (`packages/core/indexer/src/loader.ts`) finds every folder that has an `insight-plugin.json` in:

- `packages/*` in the repository, with the group folders looked into one level (`packages/frontend/*` and `packages/lens/*`; the cmake frontend is `packages/frontend/cmake`), and `plugins/*` at the repository root if that folder exists,
- `~/.insight/plugins`, and
- `.insight/plugins` inside the project being indexed (scanned last).

A plugin that fails any check (bad JSON, missing entry, wrong export, mismatched resolver scheme) is disabled with a reason, and the rest still run. Two plugins with the same id: the first one loaded wins and the other is disabled.

## The manifest

`insight-plugin.json` next to the package:

```json
{
  "id": "frontend-example",
  "version": "0.1.0",
  "description": "Example: one structure node per function in *.ex files",
  "irVersion": "^1.0",
  "detect": ["**/*.ex"],
  "files": ["**/*.ex"],
  "provides": ["structure"],
  "roles": {
    "frontend": "dist/index.js"
  }
}
```

- `files` lists the project files the frontend reads. `ctx.files` only holds paths that match it. When `files` is omitted, the `detect` globs are used, and when both are omitted, every file.
- `detect` lists globs that suggest the frontend applies. `detect(root)` still decides.
- `provides` lists the facets it fills. The coverage table in the overview reports them per run.
- `roles.frontend` is a module whose default export is the `Frontend`.
- An optional `roles.resolver` names a module whose default export is a `Resolver` for one reference scheme (see below):

  ```json
  "roles": {
    "resolver": { "scheme": "example.module", "entry": "dist/resolver.js", "priority": 50 }
  }
  ```

  `priority` decides which resolver runs first when several match. Set `"fallback": true` on a resolver that only makes syntactic guesses: its answers are used only when no resolver without the flag answered the same reference.

## detect and extract

`detect(root)` gets the absolute project path and `root.allowBuildTools`. Check the filesystem directly and return `null` when the frontend does not apply:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";

async detect(root) {
  return existsSync(join(root.path, "mix.exs")) ? { reason: "mix.exs found" } : null;
}
```

Do not run build tools unless `root.allowBuildTools` is true. The default is off.

`extract(ctx)` yields exactly one `IRBatch` per file in `ctx.files`:

```ts
async *extract(ctx) {
  for (const file of ctx.files) {
    const text = await ctx.readFile(file);
    const records = [];
    // ... parse text, push records ...
    yield { file, records };
  }
}
```

A batch can also list `dependsOn`: other project files its facts were derived from, such as the file that declares a type a call was resolved against. A change to one of them re-extracts this batch. Use `ctx.log(...)` for diagnostics; they go into the run log.

If one file throws, only that file fails. The run records it under `failed` and keeps the other files. Prefer reporting a malformed input as a `finding` record in that file's batch, so the rest of the file is still used.

## What to emit

Records are `{ node }`, `{ edge }` or `{ finding }`. The full shapes are in [ir-reference.md](ir-reference.md). The rules that matter most:

- **Ids are stable.** Derive a node id from the file and the name, for example `src/a.ex#render`. The review checklist, annotations and diffs all key on node ids and finding ids. Nothing in an id should depend on a line number that moves when someone edits above it. (The complexity lens's `@line` ids are the known exception, and they go stale when lines move.)
- **Attributes match the facet schema.** Every `attrs` object is checked against `packages/core/ir/schema/facets/<facet>.schema.json`. A `structure.function` needs a non-empty `name`, for example. A record that breaks the schema fails IR validation for the run.
- **Containment uses `parent`.** Package > module > file > function > block. A child's `parent` is the id of the node that contains it.
- **Spans are zero-based.** `span.start` and `span.end` are `[line, column]` from 0. The web app shows them 1-based.
- **Provenance is honest.** Use `exact` for what the parser proved, `inferred` for what follows from a rule, `heuristic` for a guess. A lens can show the confidence to the user.
- **Unknown targets stay unresolved.** An edge whose target is not known yet uses `{ "unresolved": { "scheme": "...", "text": "..." } }`. A resolver settles it later. Use `{ "candidates": [...] }` when several targets are possible, such as a virtual call.
- **Declare the facets you fill.** A lens that requires a facet nobody provides is skipped and reported as `unavailable`, with the reason.

## Resolvers

A resolver settles references another frontend left open. It is keyed by `scheme` and runs by `priority` (higher first):

```ts
import type { Resolver } from "@insight/sdk";

const resolver: Resolver = {
  scheme: "example.module",
  priority: 50,
  async resolve(ref, ctx) {
    const target = `${ref.text.replace(/\./g, "/")}.ex`;
    if (!ctx.hasFile(target)) return null;
    return { targets: [`${target}#module`], confidence: "inferred", note: "matched by path" };
  },
};
export default resolver;
```

Return `null` to leave the reference open. The manifest's `roles.resolver.scheme` must match the resolver's `scheme`, or the plugin is disabled.

## apiDigest (optional)

When a dependency changes, dependents are re-extracted unless the dependency's *API* did not change. Implement `apiDigest(relPath, text)` to return a digest of what other files can see (exported names, signatures). Without it, the file's whole content hash is used, which is correct and slower.

## Build-system frontends

A frontend that reads a build system (Bazel, CMake, and later Ninja or Make) draws the package boundaries and the
third-party packages of a C++ project. Its facts follow the build-system contract, which the core reads the same way for
every build system. See [build-systems.md](build-systems.md) for what the two existing frontends read, and
[ir-reference.md](ir-reference.md#build-system-packages) for the record shapes. At minimum, a build-system frontend emits:

- `structure.package` `{name, root, buildSystem}` for each package directory, with an id scoped to the build system (`//lib`, `cmake:lib`).
- `packaging.build-target` `{name, label, targetKind, output, source}` for each target, with `output` one of `executable`, `library`, `test` or `other`, and `parent` set to its package id.
- `packaging.target-contains` from each target to each file it owns.
- `packaging.dep-edge` from each target to a target, to a `packaging.external` node, or to `{unresolved: {scheme, text}}` when it cannot tell.
- `packaging.external` `{name, source, manager}` for each third-party package the build declares, with `version` and `override` when known.
- Optionally, a `cpp.include` resolver. A build-system resolver leaves `fallback` unset. The syntactic C++ resolver sets `"fallback": true`, so its answers count only when no other resolver answered (see [Resolvers](#resolvers)).

Set `provenance.frontend` and a `confidence` on every record. A heuristic read of a macro is `heuristic`, and a parse the
build file states outright is `exact`.

## Test it with the conformance kit

`runFrontendConformance` in `@insight/sdk` runs the frontend twice over the given files and reports these checks by name:

1. `detect returns a detection or null`
2. `one batch per requested file`
3. `output validates against the IR schema and kinds`
4. `facets match the declaration` (every node and edge facet is listed in `provides`)
5. `IDs and output are stable across runs`
6. `spans point at real source`
7. `unresolved references are well-formed`

Each check returns `ok` and a list of problems, so a failing check says what to fix.

Use it in the package's tests, the way `packages/frontend/bazel/test/frontend.test.ts` does:

```ts
import { runFrontendConformance } from "@insight/sdk";
import { createCoreRegistry } from "@insight/ir";

const report = await runFrontendConformance({
  frontend,
  root: { path: fixtureDir, name: "fixture", allowBuildTools: false },
  files: ["lib/a.ex"],
  readFile: (p) => readFile(join(fixtureDir, p), "utf8"),
  registry: createCoreRegistry(),
});
expect(report.checks.filter((c) => !c.ok)).toEqual([]);
```

Add golden tests on a small fixture as well: the conformance kit checks shape, not whether your facts are right. `packages/frontend/cpp/test/golden` and `packages/frontend/bazel/test/golden` hold golden IR files for this.

## Check it on a real project

After the package builds, index a project and look at the coverage table and the run log:

```sh
pnpm -r build
node apps/cli/dist/cli.js index /path/to/project
```

Coverage shows files scanned, files with records and files with errors for each facet. Parse errors and frontend findings are listed under "Index" on the project overview, not under a lens. Messages a frontend logs with `ctx.log` go to the run log.
