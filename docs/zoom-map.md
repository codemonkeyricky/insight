# Zoom map

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

### Entry points (default mode)

The Flow tab opens on an entry-point view: the functions that nothing in the scope calls, as boxes grouped by file.
The mode is the URL's `mode` query. `mode=hierarchy` selects the zoom map above, and the default has no `mode`
parameter, so the entry view's links stay short. A two-link switch at the top of the tab moves between them, and both
modes keep the scope and function.

- `apps/web/src/components/zoom/EntryMap.tsx` draws it. It is a plain SVG grid with no camera and no layout worker.
  The scene is pure: `packages/flow/src/entry-map.ts` (`entryBoxes`, `entryFrames`, `layoutEntries`, `entrySummary`,
  `ladderOf`).
- A ladder across the top lists the project and each folder down to the scope, with the counts of each ancestor's
  flow, as `unreferenced/total`: for example `Project 14/1100 › packages 31/700 › index.ts 4/9`. The total is the
  functions in scope, leaving out test, fixture and sample files while the toggle is off and counting them when it is
  on. The unreferenced count follows the same rule. The ratio falls as the scope widens, since a wider scope resolves
  references. A legend line under the ladder says so. The counts come from the flows the store has loaded, and
  `ensureChain` loads every ancestor.
- Each box shows its name and a muted `reaches N` line: the number of distinct functions it reaches through calls and
  references inside the scope. All boxes are the same size.
- The summary line counts the boxes shown, the files and the functions also called from outside the scope.
- `Include tests and samples (N)` shows the functions in test, fixture and sample files, which are hidden by default.
  `N` counts them in the scope. The checkbox is local state, so it is not in the URL.
- Each box links to its function, `scope` and `fn` in the URL. An open function's chart and detail sit below the grid.
- Escape closes the open function first, and goes up one scope when none is open.
- The entry view draws no edges. Two unreferenced functions in one scope cannot call each other, since the caller
  would make the callee referenced.
- The grid wraps at the measured width of the view, so the frames stay on screen. A frame wider than the view, such as
  a file with several columns of boxes, takes a row to itself and scrolls sideways inside the grid. A file path longer
  than 34 characters is cut from the front, with an ellipsis, and its full path is the frame's tooltip.

`FlowView` owns one `ZoomStore` and passes it to both modes, so a flow loaded for one is not loaded again for the
other. The hierarchy mode writes `mode=hierarchy` into every URL it sets.

## Verification

- `pnpm -r build` and `pnpm -r test` pass. `@insight/flow` has 101 tests across 6 files, and `@insight/web` has
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

- No anchoring: `show` fits the new focus rather than keeping the old one in place.
- Labels are not level-of-detail: the same labels draw at every zoom, and long names are not truncated.
- The ELK cache is cleared on each scope load, because each snapshot version has its own keys.
- The function level shows boxes and call edges, and the CFG chart text scales with its diagram (by design).
- Colour bands apply to file boxes only. Folder boxes stay white.
- The minimap overlays the bottom-right of the content.
- Child boxes touch the frame header with no gap.
- The old Flow tab extras are gone: the Trail, the chips, the CallLists and the per-function table. The explorer-level
  CFG list is gone too.
- The `ScopeNote` description is still shown above the flow tab.
- Enter does nothing when the centre of the view is in a gap between boxes.
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
