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

## Done and live

| Phase | What | PR |
| --- | --- | --- |
| 1 | Frontends emit `concurrency.spawns` and `concurrency.dispatches` edges | #5, #6 |
| 2 | `execModel` in `packages/flow`, `GET /scope/exec`, demo `scope/<key>/exec.json`, no UI | #6 |
| 2b | Anonymous functions, `runtime` per function, Node worker paths | #7 |

Model summary (`packages/flow/src/exec-model.ts`): `execModel(nodes, edges, scope, opts)` returns `{scope, truncated, functions, threads, dispatches, stats}`. The main thread's roots are the scope's unreferenced non-noise functions. One thread per spawn node; unresolved spawns become stubs. Coroutines come from await/start dispatches. A thread's reach does not cross spawns. Noise paths are excluded unless the scope lies inside them. Cap is `MAX_EXEC_FUNCTIONS=2000`.

## Phase 3: scene tree and layout generalization

Goal: turn the exec model into something the zoom engine can draw. No new UI tab yet.

- Define an exec scene tree next to the existing one in `packages/flow/src/scope-map.ts`. Levels: program, thread, coroutine, function, CFG. Each node has an id, kind, label, children, and the edges that cross between siblings (calls, spawns, dispatches).
- Generalize the `ZoomMap` engine in `apps/web/src/components/zoom/` so a level is not hard-wired to project, folder, file, function. Level kinds and the layout call (elkjs in a worker) come from the scene.
- Nodes with `runtime: "none"` go in a "No runtime context" group at the program level, with the explanation text carried in the scene data.
- Precompute layouts in the demo capture so the static demo does not lay out on load (also closes the existing "layouts computed client-side" gap).
- Tests: scene shape for a fixture with a spawn, a coroutine and a `none` function; layout is deterministic; the engine renders both old and new scenes.

Exit: unit tests green, a scene for the root scope builds in under the current Hierarchy time budget.

## Phase 4: UI

- The Flow tab opens on the execution canvas by default.
- Entry points becomes a "roots only" filter on that canvas.
- The hierarchy map and the Execution lens tab are absorbed. Remove the Execution lens tab once the canvas covers its content; keep the lens itself for the CLI.
- Selecting a `none` function shows: "Plain call with no runtime context. Zoom out to see where it runs."
- Keep deep links working (`#/projects/:id/view/flow?scope=`, old `mode=hierarchy`, old `lens-execution` tab redirect).
- Check with the screenshot recipe in memory (headless chromium plus playwright-core) at root, a folder, a file and a function.

## Phase 5: polish

- Label level of detail and truncation so large scopes stay readable.
- Zooming into a gap between boxes opens the nearest box.
- Restore the dropped trail and chips, the Calls and Called-by lists, and the per-function table.
- Cross-package calls currently resolve to `dist/*.d.ts` and give no edge. Map declarations to sources.
- Interface-dispatch edges, and arrow-valued object properties as function entities.
- Fix the plan page wording ("design review tool") and the Review tab name.

## Phase 6: later

- Bazel and CMake executables as programs.
- Channels and locks as edges between threads.
- Function-parameter spawns (`std::thread(fn)` where `fn` is a parameter) need data flow and are not planned yet.

## Known gaps

- `runtime` is not monotonic across scopes. A function can go from thread to none when a wider scope's module-level code references its root. Pinned as known-gap tests in `packages/flow/test/exec-model.test.ts`.
- 3 of 5 spawn sites in `samples/benchmark` resolve; the other two take the function as a parameter.
- Demo size grows with the exec data (`exec.json` totals 7.7 MB). Watch it when layouts are precomputed.

## Housekeeping

- Remove the stale `scoped-views` worktree and the old `build/entry-zoom` branch.
- Stop stale http servers on ports 8417 and 4173.
- Vercel free plan caps uploads at 5000 files per day; deploy with `--archive=tgz`.
