# Zoom map

## The Flow tab now

The Flow tab draws the execution canvas of the scope: program, threads, coroutines and functions, as one zoom map.
`apps/web/src/components/views/FlowView.tsx` holds it.

- The tab opens on the canvas. `#/projects/:id/view/flow?scope=X` opens at X, and `fn=` opens on that function's first
  place. A `mode` parameter from the old views is ignored.
- Roots only: a checkbox above the canvas writes `roots=1`. Each grounded thread then shows only the functions it starts
  in, and the plain code flow shows only the functions nothing in the flow calls (`execRootsOnly` in
  `packages/lens/flow/src/scene-filter.ts`). The layout of that cut is solved in the browser.
- A function's control-flow chart is drawn in an expansion beside its box, not inside it. The exec model gives each
  function the chart's size (`ExecFunctionRef.chart`, from `layoutFunction` in `packages/lens/flow/src/layout.ts`), and the
  scene node keeps it (`SceneNode.chart`). A function box with a chart is always compact: a box just wide enough for
  its name (`SceneNode.compact`, 36 px high), and that is the size it is laid out at. Opening an expansion never
  changes the layout, so the layout depends only on the scene and the containers open (`layoutCovers`, `layoutScene`).
- Clicking a function box with a chart opens its expansion (`apps/web/src/zoom/expand.ts`): a box to the right of the
  function, at `x = box.x + box.w + 40` and top aligned with the box, clamped so its header stays on the view. The
  chart is drawn at its natural size under a header with the name and a close button (`Expansion.tsx`). A connector
  joins the box to the expansion. A click on the box again closes its expansion. A function with no chart, or one too
  large to chart, opens nothing. A chart is drawn only once it is at least 120 px wide on screen (`CHART_MIN_PX` and
  `chartShown` in `apps/web/src/zoom/chart.ts`); narrower, the expansion shows only its header.
- A call step in an expansion's chart opens the callee's expansion to the right of the step, at
  `x = parent.x + parent.w + 40` and top aligned with the step, chained from the parent. Opening a function that is
  already open moves its expansion rather than adding a second, and a chain that would cycle is refused. Closing an
  expansion closes the expansions chained from it. Several expansions may be open at once; each new one is last.
  Escape closes the last expansion opened (and its chain), and when that expansion hangs from the selected box the
  selection moves to the box's parent. With nothing expanded, Escape goes up one level.
- The camera moves only as far as it must to show a new expansion (`revealCamera`): it pans the least that brings the
  expansion into the stage, and zooms in only when the chart is narrower than 120 px on screen, at most 1.5 times the
  current scale, with the expansion's top-left corner kept where it was. Zooming never opens a box, and a box toggle
  leaves the camera alone. A click on a step that is not a call selects it as a construct (highlighted in the chart and
  in the source panel) and does not navigate.
- A right source panel (`apps/web/src/components/zoom/FunctionSource.tsx`) sits beside the map while a function is
  selected. It shows the function's name and `file:line`, and its file through `FileViewer` with the lines highlighted
  (`hit-range`): the picked construct's span when there is one (`FlowSpan` from the chart, 1-based in `rangeOf`), else
  the whole function's span from `store.chartOf`, else the definition line. Its close button hides the panel for that
  selection; a new selection opens it again. Selecting a function that has an open expansion (a click on its header, a call
  step's callee, or a step inside its chart) moves the panel to that function. A function with no box on the map (a callee
  outside the scope, or hidden by the roots-only view) is selected off the map: the panel takes its name and file from its
  chart (`apps/web/src/zoom/offMap.ts`), and the URL keeps the last on-map focus. `FlowView.tsx` lays the map and the panel out as `.zm-split`, and stacks
  them on a phone. A saved layout whose function boxes have other sizes does not cover the scene (`layoutCovers`), so a demo or
  server layout from before the charts is solved again.
- A function's panel sits below the canvas. It shows the function's name and source line, where it runs ("Runs on
  <thread>", with the coroutine it runs in), the other places it runs, and the chart's stats and legend. A function in
  plain code flow says "Plain code flow, no runtime context found"
  (`apps/web/src/components/zoom/ExecFunctionPanel.tsx`).
- The function panel also shows its call trail and its Calls and Called by lists. The trail is the call path from its
  thread's roots; a function in plain code flow has the trail project, then the function. A coroutine, thread or the
  project (when it holds plain code flow) shows its functions as pills and a sortable table
  (`ExecContainerPanel.tsx`, `ExecLists.tsx`, helpers in `execMap.ts`).
- The map's breadcrumb is the scene path: project, process, thread, coroutine, function. There is no file level.
- The first view of a scope (no `fn=`) opens the project, every process box and every thread box, so it shows
  process ▸ thread ▸ function boxes. Coroutines and function charts stay closed (`execFirstOpen` in `execMap.ts`). With
  `fn=`, only the function's ancestors open.
- With build targets in the IR, the root is a project holding one node per executable (Bazel `*_binary`, CMake
  `add_executable`), each with its own main thread and the threads it spawns.
- Threads that take the same lock (including C++ RAII guards) are joined by a dotted `sync` edge; a channel joins its
  sender to its receiver with a solid one.
- Labels fit their box's on-screen width and drop out when too small (`apps/web/src/zoom/lod.ts`). A gesture or Enter
  over a gap opens the nearest box within 60 px. Only a click, Enter or a link opens a box; a gesture only moves the camera.
- Layouts: the demo reads `scope/<key>/exec-layout.json`, laid out with no chart expanded; the live app asks the server
  (`GET /api/projects/:id/scope/exec-layout`), which solves in a worker thread and caches per snapshot and scope. The
  browser solves only when neither has one. A layout with charts open is solved in the browser from that base layout
  (`layoutScene` with `open` and `reuse`): only the containers that differ from the base layout, and the containers above
  them, are solved again. Expansions never change the layout, so only open containers do; each set of them is kept
  (`ExecStore.layoutFor`, up to 32 sets per scope).
- For a folder or the project, the table of files sits below the canvas.
- A focus carries its scope: `execFocus(scope, nodeId)` in `apps/web/src/zoom/execMap.ts`. A node id is unique only
  within one scope's scene. `MapSource.focusOf` turns a clicked node id into a focus.
- Retired: the Hierarchy and Entry points views, and the Execution lens tab. An old `lens-execution` link (under
  `view/` or `lenses/`) redirects to the flow tab for the same scope (`redirectFor` in `router.ts`). The lens itself
  stays for the CLI.

The sections below are the history of the scope map and the entry view. Their code is removed, except the renderer
(`ZoomMap`) and the scene engine in `packages/lens/flow`, which the canvas uses.

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

The scene model is React-free and lives in `packages/lens/flow/src/scope-map.ts`:

- `buildScopeTree` turns the per-scope flows into one tree of project, folder, file and function nodes.
- `mergeCalls` merges calls across scopes into links, and `mapEdges` picks which links are drawn for an open set.
- `frontier`, `boxOf`, `focusAt`, `openFor`, `breadcrumb`, `urlFocus` and `focusFromUrl` answer what is open, what
  is visible, what is under the pointer, and what a URL names.
- `nextOpen` is the hysteresis rule: a node opens once it is wider than `EXPAND_PX` (240), and stays open while it is
  at least `COLLAPSE_PX` (200).
- `fileBands` assigns each file a colour band.

`packages/lens/flow/src/zoom-layout.ts` builds the ELK graph per container (`layoutGraphOf`), keys it (`layoutKey`), reads
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
- Open on click: a box opens when it is clicked, when Enter opens the item at the view centre, or when a link names it.
- Animated focus: an Explorer or URL change moves the camera to the new focus.
- Keyboard: `+` and `-` zoom, arrow keys pan, `Enter` opens the item at the view centre, and `Escape` collapses an
  expanded function, then goes up one level.
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

The entry-point view (`EntryMap.tsx`, `packages/lens/flow/src/entry-map.ts`) and the hierarchy map's source
(`scopeSource.ts`, `ZoomStore.build` and its layout cache) are removed. The hierarchy's camera and open-set rules
remain in `packages/lens/flow/src/scope-map.ts` and `zoom-layout.ts`, which the scene engine and the tests still use.
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
- Open on click replaces the old gesture-end hysteresis (open at 240 px, close below 200 px, decided when a wheel or drag
  ended). Opening and closing no longer depend on the camera's scale, so zooming in and out never changes the open set
  and it does not oscillate. The gesture helpers left in `apps/web/src/zoom/gesture.ts` are `pickBox` (Enter, and the
  nearest box in a gap) and `GAP_PX`.
- Wheel zoom anchors on the pointer as d3-zoom does. Only the camera moves; Enter and the gap rule use the view centre.
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
- `packages/lens/flow/src/index.ts`, `packages/lens/flow/src/zoom-layout.ts` (new) with
  `packages/lens/flow/test/zoom-layout.test.ts` (new)
- `packages/ir/src/schemas.ts` and `packages/ir/src/index.ts`: `schemaDir()` replaces a module-level
  `fileURLToPath` call, which crashed the browser bundle

Milestones 2 and 3 changed these files:

- `packages/lens/flow/src/scope-map.ts` (new), `apps/web/src/zoom/scene.ts` (new), `apps/web/src/zoom/elk.ts` (new)

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
- The canvas uses the generic engine in `packages/lens/flow/src/scene.ts` and `scene-layout.ts`: the whole scene is laid
  out once, and zoom only changes which containers draw open, so nothing moves as the camera goes in.
- The hierarchy is project ▸ process ▸ thread ▸ coroutine ▸ function (`buildExecScene`, `packages/lens/flow/src/exec-scene.ts`).
  The project is the root. A process box (kind `program`, labelled "Process" on screen) holds the threads of one build
  target or spawned process. A function is drawn once in each thread or coroutine it runs in.
- Runtime boxes are drawn only where grounded. A thread is grounded when its existence rests on evidence in the IR
  (`ExecThread.grounded` in `packages/lens/flow/src/exec-model.ts`): every spawn is, and a main thread is when one of its
  roots is a program's `main` or a function named `main`. A main thread inferred only from the scope's unreferenced
  entry functions is not grounded, and gets no thread box.
- Plain code flow: the functions of an ungrounded thread, and the functions no thread runs, sit flat on the project, with
  their call edges and no wrapper box. The project's note says "Code flow, no runtime context found in this scope." when
  no thread is grounded. There are no file nodes and no "no runtime" group.
- A container past `LAYERED_MAX_CHILDREN` (150) children is laid out in call columns (`callColumns` in
  `packages/lens/flow/src/scene-layout.ts`), not by ELK's layered algorithm, which takes seconds past a few hundred.
- The demo capture saves each scope's layout as `scope/<key>/exec-layout.json`; the page uses it when it covers the
  scene, else it solves in the elkjs worker.
