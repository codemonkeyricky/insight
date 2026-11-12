# Repository layout

```
packages/
  core/                group folder (no package.json): the stable kernel
    ir/      @insight/ir        IR schemas, kinds, validator; browser-safe main entry, Node loaders at @insight/ir/node
    sdk/     @insight/sdk       plugin interfaces, IRView; fixtures at @insight/sdk/testing, conformance at @insight/sdk/conformance
    model/   @insight/model     project model, scopes, refs, system + arch model
    flow/    @insight/flow      control-flow charts and execution model
    indexer/ @insight/indexer   plugin loader, Merkle, shards, pipeline, SQLite index (Node only)
  frontend/ bazel cmake cpp typescript    (plugins: produce IR)
  lens/     calls concurrency-map dependencies effects execution flow-complexity lock-order   (plugins: consume IR)
apps/ cli export hosted server storage-worker web   (deployables)
```

Frontends produce IR; lenses consume it; the kernel in packages/core is the contract between them.

## The rules

1. `packages/core/*` never depends on a frontend, a lens or an app.
2. `packages/frontend/*` and `packages/lens/*` depend only on `@insight/ir`, `@insight/sdk`, `@insight/model` and `@insight/flow`. They never depend on `@insight/indexer`, an app, or each other.
3. Apps reach plugins through the loader, not by importing them. `apps/hosted` lists every frontend and lens package as a dependency only so they are built and bundled. That list must equal the set of workspace packages under `packages/frontend/*` and `packages/lens/*`.
4. `ir` (main entry), `sdk` (main entry), `model` and `flow` have no `node:*` imports. The exceptions are `ir/src/node.ts` and `ir/src/schemas.ts`, and the test-only `sdk/src/testing.ts` and `sdk/src/conformance.ts`.
5. Nothing under `packages/**` depends on anything under `apps/**`.

Rules 1, 2, 3 and 5 are about declared `dependencies` and `peerDependencies`. A `devDependency` may reach further for a test, so it is not checked.

## Adding a frontend or a lens

- Create the folder `packages/frontend/<name>/` or `packages/lens/<name>/` with a `package.json` (`@insight/frontend-<name>` or `@insight/lens-<name>`) and an `insight-plugin.json` next to it. The loader finds it from there. See [writing-a-frontend.md](writing-a-frontend.md) and [writing-a-lens.md](writing-a-lens.md).
- Add it to the `dependencies` of `apps/hosted/package.json` as `"workspace:*"`, then run `pnpm install`. The layout test fails until it is listed.

## How the rules are enforced

- `packages/core/indexer/test/workspace-layout.test.ts` checks rules 1 to 5 on the workspace `package.json` files and the `src` files of the browser-safe packages. It runs with the normal test suite.
- The dependencies lens checks Insight's own source too, with the rules in `.insight/lenses/lens-dependencies.json`. Its `from` and `notDependOn` globs are over module paths. It is a partial check. It catches a relative import that crosses a layer, and it reports the rule that is broken. It does not see a package import such as `import "@insight/lens-calls"`, because the cross-package `@insight/*` imports stay unresolved in the IR, so the layout test is the check that covers rules 1, 2 and 5 across packages. The lens does not check rule 4 at all, since that rule is about `node:` imports, not module paths. The `.insight/` folder is gitignored except for `.insight/lenses/`, so only the rules file is tracked.
