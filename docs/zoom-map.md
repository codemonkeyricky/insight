# Zoom map: spike notes

The zoom map replaces the Flow tab's hand-drawn call graph with one camera over the project. Zooming in moves
from the project to a folder, from a folder to its files, from a file to its functions, and later to a function's
control-flow chart. This note records the spike that checked the stack before the scene model and the renderer
were built.

## What the spike proves

`apps/web/spike.html` (source in `apps/web/src/spike/`) runs on the demo data and does four things:

1. One d3-zoom camera over a folder (`packages/`, 183 files, 105 calls). The transform is written straight onto a
   `<g>`, and React re-renders only when the visible or expanded set changes.
2. Wheel zoom onto a file box. Once the box is 240 px wide on screen, it opens and its functions are laid out
   with their calls. Zooming back out below 200 px closes it (the hysteresis band).
3. A switch to the project root (250 files with functions, 485 file-to-file calls) through the same worker path.
4. A drag pans and leaves the open file alone.

Result: all four work in headless Chromium, with no console errors, under both the Vite dev server and the
static demo build (`VITE_STATIC=1`).

## Layout in a worker: feasible, no fallback needed

The worker is elkjs's own worker script, `elk-worker.min.js`, driven by `elk-api.js` through
`new ELK({ workerUrl })`. The URL comes from Vite's `?url` import, so it works in dev and in the static build,
where it is emitted as `assets/elk-worker.min-*.js`.

What did not work: a hand-written module worker that imports `elkjs/lib/elk.bundled.js`. `elk.bundled.js` picks
its worker shim by checking for `self`, and inside a worker that check takes over `onmessage` and exports nothing,
so the worker fails with `_Worker is not a constructor`. The bundled build is kept only for the `?elk=main`
comparison, and it is loaded with a dynamic import so it stays out of the app bundle.

## Timings

Times are in milliseconds. "Node" is the solver run in Node 24 on the demo scopes (best of three).
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

- Layout runs in the elkjs worker, not on the main thread. Layouts are about 140 to 210 ms at these sizes, which is
  a 150 ms stall on the main thread and none in the worker.
- The camera is d3-zoom with the transform applied imperatively. React state holds only what is culled or expanded.
- Expansion hysteresis: open at 240 px on screen, close below 200 px.
- A drag never changes expansion. Only wheel, click and programmatic zoom decide what is open.
- The project and folder scenes in the spike are file-level. The design's project view aggregates into folders with
  summed edges; that is the next milestone's work, not this spike's.

## Known limitations of the spike

- Expanded file frames overlap their neighbours. The frame is drawn at the larger of the file's slot and its
  function layout, and neighbours are not moved. This is accepted for now; the scene model will reserve slots.
- Function labels are not wrapped or truncated, so long names run past their boxes.
- The function level shows boxes and call edges only. The control-flow chart is not yet the deepest leaf.
- Only one file opens at a time, chosen by the pointer position.
- The spike page is not linked from the app. It is served only at `/spike.html` in dev, or by building with a
  second entry (the build config used for the static-demo run was temporary and is not committed).

## Files

- `apps/web/spike.html`, `apps/web/src/spike/zoomSpike.tsx`, `apps/web/src/spike/scenes.ts`,
  `apps/web/src/spike/elkClient.ts`
- Dependencies in `apps/web/package.json`: d3-zoom 3.0.0, d3-selection 3.0.0, d3-transition 3.0.1,
  d3-interpolate 3.0.1, elkjs 0.12.0, plus exact d3 type pins. Transitive d3 packages are pinned in
  `pnpm-workspace.yaml` `overrides` because their latest releases are less than two weeks old.
