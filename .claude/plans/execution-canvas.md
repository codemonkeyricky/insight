# Execution canvas: remaining plan

## Vision

One zoomable, pannable canvas that shows how a system runs:

Program ▸ Threads ▸ Coroutines ▸ Functions ▸ control flow

Zooming in goes one layer down, based on what is in focus. It merges the Execution lens (process, thread, coroutine) with the Flow tab (function resolution and control flow). A program box contains threads. A thread contains its root function, which calls a, b and c and dispatches to a coroutine d.

## Decisions already made

- Module-level code that lands in no thread is fine. Those functions have `runtime: "none"`. They are plain calls with no runtime context, and zooming out shows where they run. The UI must say this.
- Unresolved spawns are fixed in the language parsers, with anonymous functions in the IR (`structure.function` with `attrs.anonymous`, named `λ<line>:<col>`, plus `calls.reference` with `how: closure`).
- Worker and fork paths follow the language's own rules (Node: file-relative forms are exact, plain relative strings are cwd-relative and guessed).
- Implementation is done by Haiku subagents. The main agent reviews, merges and verifies. Each phase needs the user's go-ahead. Deploy only when the user says so.

## Done

| Phase | What | PR |
| --- | --- | --- |
| 1 | Frontends emit `concurrency.spawns` and `concurrency.dispatches` edges | #5, #6 |
| 2 | `execModel` in `packages/flow`, `GET /scope/exec`, demo `scope/<key>/exec.json`, no UI | #6 |
| 2b | Anonymous functions, `runtime` per function, Node worker paths | #7 |
| 3 | Generic scene engine, exec scene, `MapSource` renderer, hidden `mode=exec`, precomputed demo layouts | branch `ccr-f9210325-3ewpdv`, no PR yet |
| 4 | Canvas is the Flow tab, roots-only filter, lens tab redirect, function panel | same branch, not deployed |
| 5 | Server layout route (worker thread), label LoD, gap zoom, panel extras, cross-package calls, interface dispatch, wording | same branch, not deployed |
| 6 | Programs from Bazel/CMake executables, lock and channel edges | same branch, not deployed |

Model summary (`packages/flow/src/exec-model.ts`): `execModel(nodes, edges, scope, opts)` returns `{scope, truncated, functions, threads, dispatches, calls, unthreaded, stats}`; each thread also has `coroutineOnly`. The main thread's roots are the scope's unreferenced non-noise functions. One thread per spawn node; unresolved spawns become stubs. Coroutines come from await/start dispatches. A thread's reach does not cross spawns. Noise paths are excluded unless the scope lies inside them. Cap is `MAX_EXEC_FUNCTIONS=2000`.

## Phase 3: scene tree and layout generalization (done, not deployed)

Goal: turn the exec model into something the zoom engine can draw. No new UI tab yet.

### Design (settled while building)

- **Generic scene** (`packages/flow/src/scene.ts`): a tree of `SceneNode`s of any `kind`, `SceneEdge`s (`call`, `spawn`, `dispatch`) between any two nodes, and a `levels` table per kind (leaf box size, ELK options for a container of that kind). The scope tree and the exec canvas are both scenes.
- **Full layout, fixed positions** (`packages/flow/src/scene-layout.ts`): `layoutScene(scene, solve)` lays out every container bottom-up, each child with children at its full frame size. Zoom changes only which containers draw open (`placeSceneLayout(scene, layout, open)`), never where anything sits. One layout serves every focus, so it can be precomputed. The solver is passed in: the elkjs worker in the browser, `elk.bundled.js` in the demo capture and tests.
- Edges are stored once, at their real ends; `sceneEdges(scene, open)` climbs each end to its visible box and sums. `sceneLayoutGraph` climbs ends to the container's direct children so layers follow who calls whom.
- `scopeScene(tree, links)` adapts the existing scope tree, so the old scene runs through the same engine (externals are dropped: the generic engine has no stubs yet). The scope map's own dynamic-slot engine (`zoom-layout.ts`) stays as is for the Hierarchy mode until Phase 4 retires it.
- **Exec scene** (`packages/flow/src/exec-scene.ts`, `buildExecScene(model)`): `program` ▸ `thread:<id>` ▸ functions and `co:<thread>:<target>` ▸ nested coroutines. A thread, coroutine or group past `FILE_GROUP_MIN` (24) functions from more than one file groups them under `file` nodes (`<container>>file:<path>`); placement ids still name the thread, so they do not depend on grouping. A function that several threads run is placed once per thread (`<container>><fnId>`, same `ref`). `group:none` ("No runtime context") holds `runtime: "none"` functions with the explanation text in `note`. Spawn edges go from the owner's placement to the thread; dispatch edges to the coroutine node.
- **Exec model additions** so the scene needs no other input: `calls` (index pairs into `functions`, compact JSON), `unthreaded` (the `none` functions, which the model did not list before), and `coroutineOnly` per thread (to split a thread's own functions from its coroutines' ones).
- **Renderer**: `ZoomMap` reads a `MapSource` (resolve, ensureFocus, build, url) instead of `ZoomStore` directly. `ZoomStore` is one source; `ExecStore` is the other. A hidden `mode=exec` URL renders the exec canvas for verification; Phase 4 makes it the default and links it.
- **Size guard**: a layered container past `LAYERED_MAX_CHILDREN` (150) children is packed with rectpacking instead (edges ignored). ELK layered grows much faster than linearly: 260 functions take 0.4 s, 600 about 7 s, 1500 about 25 s.
- **Demo**: the capture writes `scope/<key>/exec-layout.json` (the `SceneLayout`) next to `exec.json`. The page uses it when `layoutCovers` says it matches, else solves in the worker. Hierarchy layouts stay client-side: they depend on the open set and the loaded flows, and Phase 4 retires that engine.

### Steps

- [x] Exec model: `calls`, `unthreaded`, `coroutineOnly`, tests.
- [x] `scene.ts` types, `scene-layout.ts` engine, `scopeScene`, tests with real elkjs (determinism, positions fixed across open sets, rectpacking, `scopeScene` graphs equal `layoutGraphOf`).
- [x] `exec-scene.ts`, tests (spawn, coroutine, nested coroutine, shared helper, `none` group, file grouping, determinism).
- [x] File grouping and the layered size guard, after measuring the root scope (below).
- [x] Web: `MapSource` (`apps/web/src/zoom/source.ts`), `scopeSource`, `ExecStore`, hidden `mode=exec`, static `exec-layout.json`, exec styles.
- [x] Capture: precompute exec layouts, measure size and time.
- [x] Verify: all tests, demo build, browser smoke of `mode=exec` and `mode=hierarchy`, root-scope timings.

### Results

Measured on this repository (root scope: 1749 functions, 59 threads, 2118 calls, 754 unthreaded):

| Step | Root scope |
| --- | ---: |
| `execModel` (Node) | 67 ms |
| `buildExecScene` (Node) | 18 ms, 2367 nodes, 2696 edges |
| `layoutScene` with elkjs (Node), before file grouping | not feasible: main thread 935 children, about 25 s for that container alone |
| `layoutScene` with elkjs (Node), after file grouping | 2.2 s; largest container 69 children |
| Demo, navigation to first boxes (headless Chromium, precomputed layout) | 177 ms |

- Capture: 411 `exec-layout.json` files, 4.51 MB, 34.7 s to lay out in all, slowest the project at 2.2 s. Exec models grew from 7.7 to 9.46 MB with the new fields.
- Tests: flow 203, web 66, server 55, every other package green. `packages/core`'s `benchmark.test.ts` times out in its 10 s `beforeAll` when `pnpm -r test` runs packages in parallel, and passes alone in 5 s. Core does not depend on flow or web, so this is load sensitivity, not this phase.
- Browser (playwright, demo build): exec at the root, `packages/core` and `packages/flow` loads the saved layout and solves nothing; wheel and click open program ▸ thread ▸ file ▸ function with the URL in step; Escape climbs back to the program; a `fn=` deep link opens on its first placement; `mode=hierarchy` links behave as before; no console errors; no horizontal scroll at 390 px.
- Exit criterion: met for the scene build (18 ms) and for the demo (precomputed). Not met for the live app at the root: the worker solves the root in about 2.2 s (off the main thread, measured in Node). See Phase 5.

## Phase 4: UI (done)

- [x] The Flow tab opens on the execution canvas by default (`FlowView.tsx`).
- [x] Entry points became a "Roots only" filter on the canvas: `roots=1`, `execRootsOnly` in `packages/flow/src/scene-filter.ts`.
- [x] The hierarchy map, the entry view and the Execution lens tab are absorbed. Removed: `EntryMap.tsx`, `scopeSource.ts`, `packages/flow/src/entry-map.ts`, `ZoomStore`'s layout half. The lens package stays for the CLI.
- [x] A function in the no-runtime group shows "Plain call with no runtime context. Zoom out to see where it runs." (`ExecFunctionPanel.tsx`).
- [x] Deep links: `?scope=`, `fn=` (first placement), old `mode=hierarchy|entries|exec` (ignored, open the canvas), and `lens-execution` under `view/` or `lenses/` (redirects via `redirectFor`).
- [x] A focus carries its scope (`execFocus(scope, nodeId)`), which closes the old `ExecStore` scope-state gap.
- [x] Checked in headless Chromium at the root, a folder, a file and a function (see Verification).

## Phase 5: polish (done)

- [x] Live root layout: the server answers `GET /api/projects/:id/scope/exec-layout`, solved in a `worker_threads` worker and cached per snapshot and scope. A 900-function solve keeps the event loop's longest gap at 14 ms (614 ms on the main thread).
- [x] Label level of detail and truncation (`apps/web/src/zoom/lod.ts`): labels fit the box's on-screen width, paths cut from the front, none under 5 characters, recomputed per quarter-octave of zoom.
- [x] Zooming into a gap opens the nearest box within 60 screen px (`nearestBox`), for gestures and Enter.
- [x] Restored the trail, the chips, the Calls and Called-by lists and the per-function table on the canvas's panel.
- [x] Cross-package calls map `dist/*.d.ts` declarations to their sources through each package's tsconfig: 0 → 400 cross-package call edges on this repository.
- [x] Interface dispatch (`calls.call` with candidates, `how: "interface"`, cap 32) and arrow-valued object properties as named functions (`<binding>.<prop>`): 111 newly named functions, 8 dispatch edges in this repository's own code. Method shorthand in a bound literal is now `<binding>.<prop>` too, which renamed 23 ids.
- [x] Wording: the package description no longer says "design review tool", and the Review tab is "Triage" (route id still `review`).

## Phase 6 (done, except the item marked not planned)

- [x] Bazel and CMake executables as programs: `ExecModel.programs`, a main thread per program with a `main`, and `project ▸ program ▸ thread` in the scene. To make it real on C++, frontend-bazel now models `*_binary` rules of any language, and the CMake plugin expands `macro()`/`function()` bodies. On `samples/benchmark`: 10 → 63 build targets and 0 → 54 programs (53 CMake test executables and the `py_binary`).
- [x] Channels and locks as edges between threads: `ExecModel.resources` and `sync` scene edges (dotted for a lock, solid sender → receiver for a channel). C++ RAII guards (`x-cpp.scoped-lock`) count as lock sites.
- [ ] Function-parameter spawns (`std::thread(fn)` where `fn` is a parameter) need data flow. Still not planned.

## Known gaps

- `runtime` is not monotonic across scopes. A function can go from thread to none when a wider scope's module-level code references its root. Pinned as known-gap tests in `packages/flow/test/exec-model.test.ts`.
- 3 of 5 spawn sites in `samples/benchmark` resolve; the other two take the function as a parameter (the Phase 6 item above).
- No frontend emits `concurrency.channel-send`/`channel-recv` yet, so channel edges exist only in tests. On the samples the lock resources found are each used by one thread, so no sync edge shows yet on real data.
- CMake: `if()` and `foreach()` are not evaluated (every command inside is read), `PARENT_SCOPE` is ignored, and a macro defined in a parent directory is not seen in a subdirectory.
- Interface dispatch: structural matches (no `implements`), object-literal implementers and class expressions are not covered.
- Cross-package calls need the packages built (`dist/*.d.ts` present) when indexing.
- The roots-only view is laid out in the browser on every open.
- The demo is over the capture's 40 MB budget even after trimming file and folder scopes (see Verification); the exec models and layouts dominate.
- WIP commits: this branch has many "WIP" snapshot commits (pushed while parallel agents were mid-task); squash when a PR is opened if a clean history matters.

## Housekeeping

- The `scoped-views` worktree and the `build/entry-zoom` branch exist only on the original machine; neither is in this checkout or on the remote (the remote has `build/entry-zoom-final` and `build/scoped-views`, left alone). Remove them there.
- No stale servers were listening on 8417 or 4173 in this environment.
- Vercel free plan caps uploads at 5000 files per day; deploy with `--archive=tgz`. Not deployed: deploy only when asked.

## Verification

Final run on this branch, after every phase:

- `pnpm -r build` and `pnpm -r --no-bail test`: all green. flow 222, web 141, server 61, core 81, frontend-typescript 56, frontend-bazel 14, and the rest. core's `benchmark.test.ts` setup now allows 60 s, since indexing the larger sample under a parallel run passed the default 10 s.
- Root scope of this repository: 1860 functions (not truncated), 60 threads, 2429 calls, 1115 unthreaded; model 95 ms, scene 19 ms, whole layout 2.7 s in a solver (the server does it once per snapshot, in a worker; the demo has it saved).
- Demo capture: 716 scopes, 437 exec models (12.4 MB) and layouts (10.2 MB, 78.5 s to solve, slowest the `samples` scope at 9.0 s). Total 58.3 MB in 2729 files: over the 40 MB budget even with file and folder scopes trimmed to the complexity lens. The file count is well under Vercel's 5000.
- Headless Chromium on the demo build, with no console errors and no horizontal scroll at 390 px:
  - root: 61 thread boxes; the main thread, the no-runtime group and the spawned thread are labelled, and the 58 boxes too small for a label draw none;
  - folder `packages/flow`, file `packages/flow/src/exec-model.ts`: the canvas and the container panel (pills and table);
  - function `buildExecScene`: breadcrumb `packages/flow › Main thread › exec-scene.ts › buildExecScene`, the trail, "Runs on Main thread", the chart and the call lists;
  - roots only (`roots=1`), an old `mode=hierarchy` link, and `lens-execution` under both `view/` and `lenses/` (redirected to Flow); the Execution lens tab is gone from the tab bar;
  - a thread focus: 60 pills and a 291-row table.
  - Not shown by the browser run: the gap zoom (the scripted wheel did not cross the open threshold); it is covered by unit tests only.
