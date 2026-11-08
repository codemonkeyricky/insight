# Zoom map

## The Flow tab now

The Flow tab draws the execution canvas of the scope: program, threads, coroutines and functions, as one zoom map.
`apps/web/src/components/views/FlowView.tsx` holds it.

- The tab opens on the canvas. `#/projects/:id/view/flow?scope=X` opens at X, and `fn=` opens on that function's first
  place. A `mode` parameter from the old views is ignored.
- Roots only: a checkbox above the canvas writes `roots=1`. Each thread then shows only the functions it starts in
  (`execRootsOnly` in `packages/flow/src/scene-filter.ts`). The layout of that cut is solved in the browser.
- A function's panel sits below the canvas. It shows the function's name and source line, where it runs ("Runs on
  <thread>", with the coroutine it runs in), the other places it runs, and its control-flow chart. A function in the
  no-runtime group says "Plain call with no runtime context. Zoom out to see where it runs."
  (`apps/web/src/components/zoom/ExecFunctionPanel.tsx`).
- The function panel also shows the call trail from its thread's roots and its Calls and Called by lists. A file
  group, coroutine, thread or the no-runtime group shows its functions as pills and a sortable table
  (`ExecContainerPanel.tsx`, `ExecLists.tsx`, helpers in `execMap.ts`).
- With build targets in the IR, the root is a project holding one node per executable (Bazel `*_binary`, CMake
  `add_executable`), each with its own main thread and the threads it spawns.
- Threads that take the same lock (including C++ RAII guards) are joined by a dotted `sync` edge; a channel joins its
  sender to its receiver with a solid one.
- Labels fit their box's on-screen width and drop out when too small (`apps/web/src/zoom/lod.ts`). A gesture or Enter
  over a gap opens the nearest box within 60 px.
- Layouts: the demo reads `scope/<key>/exec-layout.json`; the live app asks the server
  (`GET /api/projects/:id/scope/exec-layout`), which solves in a worker thread and caches per snapshot and scope. The
  browser solves only when neither has one.
- For a folder or the project, the table of files sits below the canvas.
- A focus carries its scope: `execFocus(scope, nodeId)` in `apps/web/src/zoom/execMap.ts`. A node id is unique only
  within one scope's scene. `MapSource.focusOf` turns a clicked node id into a focus.
- Retired: the Hierarchy and Entry points views, and the Execution lens tab. An old `lens-execution` link (under
  `view/` or `lenses/`) redirects to the flow tab for the same scope (`redirectFor` in `router.ts`). The lens itself
  stays for the CLI.

The sections below are the history of the scope map and the entry view. Their code is removed, except the renderer
(`ZoomMap`) and the scene engine in `packages/flow`, which the canvas uses.

The zoom map replaces the Flow tab's hand-drawn call graph with one camera over the project. Zooming in moves from
the project to a folder, from a folder to its files, from a file to its functions, and from a function to its
control-flow chart (CFG). Zooming out moves back up the same chain. The URL follows the focus, and the camera follows
the URL and the Explorer.

The work came in three milestones. M1 was the spike that checked the stack. M2 was the scene model. M3 is the
renderer described below.

## Milestones

### M1: spike (commits 2cdfe95 and earlier)

The spike checked the stack on the demo data: one d3-zoom camera over a folder, wheel zoom onto a file box that opens
its functions at 240 px and closes below 200 px, a switch to the project root through the worker, and a drag that
leaves the open file alone. All four worked in headless Chromium with no console errors, under both the Vite dev
server and the static demo build.

Layout runs in elkjs's own worker script (`elk-worker.min.js`) through `elk-api.js`, with `new ELK({ workerUrl })`.
The URL comes from Vite's `?url` import, so it works in dev and in the static build. A hand-written module worker
that imports `elkjs/lib/elk.bundled.js` does not work: the bundle picks its worker shim by checking for `self`, and
inside a worker the check takes over `onmessage` and exports nothing (`_Worker is not a constructor`).

### M2: scene model (commit 415c3f5)

The scene model is React-free and lives in `packages/flow/src/scope-map.ts`:

- `buildScopeTree` turns the per-scope flows into one tree of project, folder, file and function nodes.
- `mergeCalls` merges calls across scopes into links, and `mapEdges` picks which links are drawn for an open set.
- `frontier`, `boxOf`, `focusAt`, `openFor`, `breadcrumb`, `urlFocus` and `focusFromUrl` answer what is open, what
  is visible, what is under the pointer, and what a URL names.
- `nextOpen` is the hysteresis rule: a node opens once it is wider than `EXPAND_PX` (240), and stays open while it is
  at least `COLLAPSE_PX` (200).
- `fileBands` assigns each file a colour band.

`packages/flow/src/zoom-layout.ts` builds the ELK graph per container (`layoutGraphOf`), keys it (`layoutKey`), reads
the solved positions back (`readLayout`), places the scene (`placeScene`), and places the edges (`placeEdges`). Slots
for expanded frames are reserved in the layout, so an opened container does not overlap its siblings. Stubs for
calls that leave the open scope are dashed (`stubsFor`).

`apps/web/src/zoom/scene.ts` holds `ZoomStore`. It loads scope flows lazily, caches layouts per container, and runs
the ELK solves through `apps/web/src/zoom/elk.ts`. `ensureFocus` loads the file of the focused function before its
CFG is shown.

### M3: renderer

`apps/web/src/components/zoom/ZoomMap.tsx` draws the map:

- A d3-zoom camera. The transform is written straight onto the world `<g>`. React re-renders only when the culled
  visible set changes.
- Viewport-culled SVG: only boxes, frames, stubs and edges that intersect the view are rendered.
- Lazy, cached ELK layouts per container, solved in the worker.
- Hysteresis expand and collapse at 240 px and 200 px on screen.
- Animated focus: an Explorer or URL change moves the camera to the new focus.
- Keyboard: `+` and `-` zoom, arrow keys pan, `Enter` opens the item at the view centre, and `Escape` goes up one
  level.
- A breadcrumb (`ZoomMap` draws it; the Flow tab's explorer trail is turned off with `ScopeNote trail={false}`).
- A minimap, and a resolution meter that reads as text.
- Dashed external stubs for calls that leave the open scope.
- File colour bands. Folder boxes stay white.
- A function's CFG is the deepest leaf. `apps/web/src/components/zoom/FunctionDetail.tsx` renders it with `FlowChart`
  from `@insight/flow`.
- URL sync both ways through `replaceState`, so the history does not fill up. An Explorer or URL change animates
  the camera; a camera gesture does not change the Explorer.
- `Workspace` gives the flow tab a view key without the scope, so the map stays mounted when the scope changes and
  the camera animates instead.

Replaced and removed: `CallGraph.tsx`, `flowGraph.ts` and `flowGraph.test.ts` are deleted, and so are
`apps/web/spike.html` and `apps/web/src/spike/`. `FlowView.tsx` now renders the zoom map.

## Retired views

The entry-point view (`EntryMap.tsx`, `packages/flow/src/entry-map.ts`) and the hierarchy map's source
(`scopeSource.ts`, `ZoomStore.build` and its layout cache) are removed. The hierarchy's camera and open-set rules
remain in `packages/flow/src/scope-map.ts` and `zoom-layout.ts`, which the scene engine and the tests still use.
The entry view's design, camera and checks are in the git history before the Phase 4 change.

## Verification

- `pnpm -r build` and `pnpm -r test` pass. `@insight/flow` has 125 tests across 7 files, and `@insight/web` has
  55 tests across 4 files. The other packages pass too, with no failures.
- `pnpm --filter @insight/web build:demo` builds. The demo is served from `apps/web/dist-demo` on a static port.
- A playwright-core script drove the demo through real wheel, drag and keyboard input. It checked, with no console or
  page errors:
  - wheel-zoom descends project, folder, file, function, CFG in turn;
  - zoom-out ascends back the same chain;
  - the URL `scope` and `fn` follow the focus;
  - the Explorer and URL changes animate the camera;
  - the minimap and breadcrumb are clickable;
  - the page has no horizontal scroll at phone width.
- Screenshots were checked for each level, the minimap and the breadcrumb.
- The entry view was checked the same way at the file, folder, package and project scopes: the ladder counts and
  boxes match each scope's flow, a box opens its chart and Escape closes it, the tests toggle adds the test boxes, the
  grid fits its stage, and the phone width has no page overflow. A check of the per-function monotone rule over the
  captured demo found no problems.

## Timings

Times are in milliseconds, from the M1 spike. "Node" is the solver run in Node 24 on the demo scopes (best of three).
"Browser" is headless Chromium, measured around the call on the main thread.

| Layout | Nodes | Edges | Node (best) | Browser, dev worker | Browser, static worker | Browser, main thread |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Folder `packages/` (183 files from `files.json`) | 183 | 105 | 32 | 208 (first call, includes worker start) | 139 | 176 to 182 |
| Project root (250 files with functions) | 250 | 485 | 162 | 179 | 176 | 171 to 173 |
| Packages scope rows only (97 files with functions) | 97 | 105 | 23 | not timed in browser | not timed in browser | not timed in browser |
| One file's functions (`packages/core/src/diff.ts`, 16 boxes) | 16 | n/a | n/a | 8 | 8 | 7 |

The first browser layout includes starting the worker and registering the algorithms. Later layouts are the
steady-state cost.

Main-thread stall during the project-root switch, measured as the longest gap between animation frames:

| Mode | Longest frame gap | Frames with a gap over 50 ms |
| --- | ---: | ---: |
| Worker (dev) | 16.7 ms | 0 |
| Worker (static build) | 16.8 ms | 0 |
| Main thread (`?elk=main`) | 150.1 ms | 1 |

Camera updates (culling plus the transform) took 0.1 to 0.6 ms per update in every run. React commit time
(Profiler, dev only; the production build drops it) had a p95 of 3.1 ms.

## Decisions

- Layout runs in the elkjs worker, not on the main thread. Layouts take about 140 to 210 ms at these sizes, which
  is a 150 ms stall on the main thread and none in the worker.
- The camera is d3-zoom with the transform applied imperatively. React state holds only what is culled or expanded.
- Expansion hysteresis: open at 240 px on screen, close below 200 px. The rule is applied at the end of a user
  gesture only, so a drag never changes expansion.
- `mayOpen` gating: a child may open only when the gesture did not zoom out. This stops file, folder, file
  oscillation during a zoom-out.
- Wheel zoom anchors on the pointer. The world point under the pointer is stored at gesture start, so a wheel
  over a gap still descends into the box the pointer is over. Keyboard and drag use the view centre.
- `ensureFocus` runs before `show()` builds the scene, so a function's file is loaded before its CFG is drawn.
- Labels keep a constant screen size. The world group sets `--zinv` (1/scale) and the label font sizes are
  `calc()` expressions on it.
- Strokes use `vector-effect: non-scaling-stroke`, so edges and box outlines stay thin at any zoom. Arrowheads use
  `markerUnits="userSpaceOnUse"` with a fixed marker size, so they keep a visible size.
- `Workspace` leaves the scope out of the view key for the flow tab, so scope changes animate instead of remounting.
- `ScopeNote` takes a `trail` prop. The flow tab turns its explorer trail off, because the map draws its own.

## Known limitations

These describe the execution canvas, which is what the Flow tab draws now. The hierarchy map's own limitations went
with it (see Retired views).

- No anchoring: `show` fits the new focus rather than keeping the old one in place.
- Labels fit their boxes per quarter-octave of zoom (`apps/web/src/zoom/lod.ts`), from an estimated 7.2 px per
  character rather than measured text, so a wide-glyph name can still overrun a little.
- The CFG chart lives in the function panel below the canvas, not in the function's slot on the canvas.
- The minimap overlays the bottom-right of the content.
- Child boxes touch the frame header with no gap.
- The `ScopeNote` description is still shown above the flow tab.
- The roots-only view is laid out in the browser on every open (it is small, but not precomputed or cached by the
  server).
- The packages `ir` build externalises `node:url`, `node:fs` and `node:path` for the browser. The warnings are
  harmless, because the loaders that use them are not called in the browser.

## Files

Milestone 3 changed these files:

- `apps/web/src/components/zoom/ZoomMap.tsx` (new), `apps/web/src/components/zoom/FunctionDetail.tsx` (new)
- `apps/web/src/components/views/FlowView.tsx`, `apps/web/src/components/Workspace.tsx`,
  `apps/web/src/components/ScopeNote.tsx`, `apps/web/src/components/FlowChart.tsx`
- `apps/web/src/styles.css`
- `apps/web/src/flowTargets.ts` (new) with `apps/web/test/flowTargets.test.ts` (new)
- `packages/flow/src/index.ts`, `packages/flow/src/zoom-layout.ts` (new) with
  `packages/flow/test/zoom-layout.test.ts` (new)
- `packages/ir/src/schemas.ts` and `packages/ir/src/index.ts`: `schemaDir()` replaces a module-level
  `fileURLToPath` call, which crashed the browser bundle

Milestones 2 and 3 changed these files:

- `packages/flow/src/scope-map.ts` (new), `apps/web/src/zoom/scene.ts` (new), `apps/web/src/zoom/elk.ts` (new)

Removed:

- `apps/web/src/components/CallGraph.tsx`, `apps/web/src/flowGraph.ts`, `apps/web/test/flowGraph.test.ts`
- `apps/web/spike.html`, `apps/web/src/spike/` (`zoomSpike.tsx`, `scenes.ts`, `elkClient.ts`)

Dependencies in `apps/web/package.json`: d3-zoom 3.0.0, d3-selection 3.0.0, d3-transition 3.0.1,
d3-interpolate 3.0.1, elkjs 0.12.0, plus exact d3 type pins. Transitive d3 packages are pinned in
`pnpm-workspace.yaml` `overrides` because their latest releases are less than two weeks old.

## Execution canvas (Phase 3)

The renderer draws the execution canvas, `program ▸ thread ▸ coroutine ▸ function`, built from a scope's exec model.
It is the Flow tab's view since Phase 4 (see `.claude/plans/execution-canvas.md`).

- `ZoomMap` reads a `MapSource` (`apps/web/src/zoom/source.ts`): `resolve`, `ensureFocus`, `build`, `url` and
  `focusOf`. The canvas's source is `ExecStore`.
- The canvas uses the generic engine in `packages/flow/src/scene.ts` and `scene-layout.ts`: the whole scene is laid
  out once, and zoom only changes which containers draw open, so nothing moves as the camera goes in.
- `buildExecScene` (`packages/flow/src/exec-scene.ts`) groups a big container's functions by file, and a layered
  container past 150 children is packed instead, because ELK's layered algorithm takes seconds past a few hundred.
- The demo capture saves each scope's layout as `scope/<key>/exec-layout.json`; the page uses it when it covers the
  scene, else it solves in the elkjs worker.
