# Arch view

## Arch tab

The Arch tab draws the package-level architecture of a project: one box per package, one arrow per import between two
packages. The explorer scope picks what is drawn. At the root (the project) it draws the whole project. At a folder or a
package it draws that scope, as described under "Scoped view" below.

### Data flow

- The model is built by `archModel(view)` in `packages/core/model/src/arch/arch.ts`. It reads an `IRView` over the whole
  snapshot and returns plain JSON: `layers`, `packages`, `edges`, `unresolved`, `externals` and `violations`.
- The server builds it in `scopeArchOf` (`apps/server/src/reader.ts`) and serves it at
  `GET /api/projects/:id/scope/arch?path=`. The path is required and names a scope as the other scope routes do. The
  model is the same for every scope, so the path only checks that the scope exists. Errors match `/scope/exec`.
- The web app reads it with `api.getScopeArch(id, scope)` (`apps/web/src/api.ts`). The view is
  `apps/web/src/components/views/ArchView.tsx`, and its geometry is in `apps/web/src/arch/layout.ts`. The view fetches
  the root model once per project. A scope is derived from it in the browser (see "Scoped view").
- The demo reads the same model from `scope/@root/arch.json`. `scripts/capture-demo.mjs` writes it for the root scope
  only, and `staticApi.getScopeArch` reads that one file for every scope.

### What the diagram shows

- Columns, left to right, one per layer in `model.layers` that holds packages. The layers come from the path of each
  package (`defaultLayerOf`: `frontend-*` or `frontend/*` under `packages/` or `plugins/`, `packages/lens/*` (and `lens-*`), `packages/core/*` (the kernel group: ir, sdk, model, flow, indexer; layer `ir`), and `apps/*`), and
  any other package is in "other".
- Packages come from `package.json` files among the indexed files, or from `structure.package` nodes when a frontend
  emits them. A file belongs to its nearest package root. Each box shows the file count.
- An arrow for each pair of packages with at least one import or call between them. The label is the import count, or
  the call count with a "c" when the IR saw no import. The width grows with the count, from 1 to 4 px. A dashed arrow
  means the weakest confidence of its evidence is not exact.
- Workspace imports. The IR cannot resolve `@insight/indexer` (it points into the package's build output), so such an
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

### Scoped view

A folder or package scope draws what is inside it, with the packages around it. The derivation is `scopedView(model,
scope)` in `apps/web/src/arch/scoped.ts`, a pure function of the root model, so no server call is needed. The root scope
(and a file at the root) keeps the whole-project diagram.

- The scope is a folder path. A file scope uses its folder, and the caption says so. The scope's package is the nearest
  package that contains it.
- The middle band holds the cards inside the scope. They are the folders of its files that hold code, cut at the
  shallowest depth that gives at least three such folders, with the scope's own files as "(files)" beside its
  subfolders. When fewer than three folders hold code and the scope has at most 60 drawn files, each file is a card
  instead. A file is drawn when it holds a function or an import reaches it, so a package.json or config file is not a
  card. Folders without code are left out and counted under the diagram; files left out are counted in the caption.
- The left column ("Imported by") holds what imports the scope. The right column ("Imports") holds what the scope
  imports. A card is a package, or for a file of the scope's own package, the sibling folder at the scope's depth. Each
  boundary card's line counts its imports over its arrows.
- Arrows come from the file-level imports, and from the package edges for imports the IR could not resolve to a file
  (workspace specifiers). A package import site that is already a file import is not counted twice. Package edges with
  no import site (calls only) cannot be drawn, and the caption counts them.
- The band is two cards wide when the diagram's container (the centre pane) is at least 1400 px, one card otherwise. A
  drawing wider than the container is scaled to fit, so no column is cut off. The cards are coloured by layer: the left,
  the band and the right each keep one colour. The side panel also lists the scope's package's external packages.
- A click on a folder or package card opens that scope in the Arch tab. A click on a file card opens its source. The
  workspace's scope crumbs keep the Arch tab, so the view adds no breadcrumb of its own. "Open in Flow" opens the scope in
  the Flow tab. At the root, a package or folder click also opens Arch, at that scope.
- A boundary card for the root package is named "project root". A sibling folder is named by its path inside the
  package, and its full path is in the card's tooltip.

### What the diagram does not show

- No hand-drawn Project or Web UI columns. Every column comes from a package's layer.
- No arrow verbs (scan, emit, read, serve). An arrow says that packages are connected and how often.
- Arrows are straight or gently curved lines, so one can pass under a box between its two ends.
- At the root, no edges inside one package, and no per-file edges. Import sites are kept on each arrow, but the arrows are
  between packages only. A scoped view with file cards (see "Scoped view") does draw edges between its files.
- No unresolved imports from files that belong to no package. They have no package to be listed under.
