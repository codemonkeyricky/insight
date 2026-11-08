# Arch view

## Arch tab

The Arch tab draws the package-level architecture of a project: one box per package, one arrow per import between two
packages. It always covers the whole project, whatever the explorer scope is, as the Overview tab does.

### Data flow

- The model is built by `archModel(view)` in `packages/lens-dependencies/src/arch.ts`. It reads an `IRView` over the whole
  snapshot and returns plain JSON: `layers`, `packages`, `edges`, `unresolved`, `externals` and `violations`.
- The server builds it in `scopeArchOf` (`apps/server/src/reader.ts`) and serves it at
  `GET /api/projects/:id/scope/arch?path=`. The path is required and names a scope as the other scope routes do. The
  model is the same for every scope, so the path only checks that the scope exists. Errors match `/scope/exec`.
- The web app reads it with `api.getScopeArch(id, scope)` (`apps/web/src/api.ts`). The view is
  `apps/web/src/components/views/ArchView.tsx`, and its geometry is in `apps/web/src/arch/layout.ts`.
- The demo reads the same model from `scope/@root/arch.json`. `scripts/capture-demo.mjs` writes it for the root scope
  only, and `staticApi.getScopeArch` reads that one file for every scope.

### What the diagram shows

- Columns, left to right, one per layer in `model.layers` that holds packages. The layers come from the path of each
  package (`defaultLayerOf`: `frontend-*` and `plugins/frontend-*`, `lens-*`, `ir`/`sdk`/`core`, and `apps/*`), and
  any other package is in "other".
- Packages come from `package.json` files among the indexed files, or from `structure.package` nodes when a frontend
  emits them. A file belongs to its nearest package root. Each box shows the file count.
- An arrow for each pair of packages with at least one import or call between them. The label is the import count, or
  the call count with a "c" when the IR saw no import. The width grows with the count, from 1 to 4 px. A dashed arrow
  means the weakest confidence of its evidence is not exact.
- Workspace imports. The IR cannot resolve `@insight/core` (it points into the package's build output), so such an
  import is matched by name: a scoped specifier whose name is exactly one package's directory name becomes an import
  edge to that package, with confidence "inferred" unless calls already link the two. Any other bare specifier (an npm
  package or a Node built-in) is an external dependency, counted per package and listed when the package is selected.
  `package.json` files under `test`, `tests`, `fixtures`, `samples` or `node_modules` are not packages.
- Selecting a box lights its incoming and outgoing arrows and lists what it imports and what imports it. Selecting an
  arrow shows its import counts, confidence and every import site as a `file:line` link to the Source tab.
- Rule violations are drawn in the error colour and listed at the top of the side panel when nothing is selected. The
  one rule so far is that frontends and lenses never import each other.
- Unresolved imports, the relative or absolute imports that resolve to nothing, are listed with their package and their
  source line.

### What the diagram does not show

- No hand-drawn Project or Web UI columns. Every column comes from a package's layer.
- No arrow verbs (scan, emit, read, serve). An arrow says that packages are connected and how often.
- Arrows are straight or gently curved lines, so one can pass under a box between its two ends.
- No edges inside one package, and no per-file edges. Import sites are kept on each arrow, but the arrows are between
  packages only.
- No unresolved imports from files that belong to no package. They have no package to be listed under.
