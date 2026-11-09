# Drafting sheet: web UI redesign plan

## Goal

Redraw the Insight web app as one engineering drawing of the codebase. Flow, the zoomable execution canvas, becomes the sheet itself: a zoned drawing with a title block, line types for runtime frames, lettered detail views for control flow, and revision clouds for findings. Today's eight-plus tabs become three modes, **Flow / Arch / Findings**, plus a Find palette, a Files drawer and a source side panel.

- POC (interactive, uses real data from this repo's demo scope): https://claude.ai/artifact/N2xdd7zK4JCk8JC9XEoREb
- POC source, kept for reference: `.claude/plans/drafting-sheet-poc/` (`index.html`, `data.json`, `data2.json`). The POC is plain DOM and SVG, not React. Copy its ideas and constants, not its code.

## Decisions already made (carry over, do not relitigate)

- Runtime boxes (process, thread, coroutine) appear only when grounded in the exec model. Functions with `runtime: "none"` sit in the "No runtime context" group, with the text "plain code with no runtime context".
- Gestures never auto-focus or auto-fly the camera. A click selects. It does not move the map (PR #12, `apps/web/src/zoom/gesture.ts`). The camera moves only when the user asks: a key, Find, a link, or fit.
- A function's expansion opens to the RIGHT of the function (PR #15, `placeOnBox` in `apps/web/src/zoom/expand.ts`). A call step's expansion opens right of its parent expansion.
- The source panel follows the chain: selecting a step in a nested expansion shows that callee's source (PR #16).
- Click-to-open (PR #13): clicking a box opens it. A container opens to its children, and a function opens its chart.
- Implementation is done by Haiku subagents. The main agent merges and verifies. Each phase needs the user's go-ahead. Deploy only when the user says so. Branches are `build/*`, PRs go to master, and nothing is pushed straight to master.
- Names avoid the word "review" (the `review` route keeps its id; its label stays **Triage**).

## What the current UI gets wrong

From the screenshots taken for the POC:

1. **Too many peer tabs.**
   - The tab bar (`Workspace.tsx:180-206`) shows Overview, Source, Flow, Arch and Findings, then every lens, then Compare and Triage, with equal weight.
   - Source is a view of a selection, not a place, and Overview is metadata.
2. **Flow is strong but reads as generic boxes.**
   - Runtime frames, file groups and functions all share one box style.
   - Thread vs coroutine vs process is told by label text only.
3. **The expansion overlays the map.**
   - The chart box opens right of the function and covers the next column (layout is fixed by design, see `expand.ts:1-5`).
   - You can't see what the function calls while you read its chart.
4. **Findings are a list away from the code.**
   - Findings are counted per kind, but there's no way to see *where* they sit on the Flow canvas.
5. **No visual system.**
   - `styles.css` (395 lines) has ad-hoc greys and no tokens.
   - Dark mode is partial. Cytoscape lens graphs ignore the theme.
6. **Phones.** The split source panel squeezes the map, and the tab bar wraps.

## Visual system

Apple-style "liquid glass", not the drafting palette. Tokens are copied from the approved mockup (`poc/index.html`).

### Tokens (CSS custom properties on `:root`)

- Light tokens sit on `:root`. Dark tokens apply under `:root[data-theme="dark"]` and under `@media (prefers-color-scheme: dark)` for `:root:not([data-theme="light"])`.
- Core set: `--film` (page behind the sheet), `--sheet`, `--box`, `--raised`, `--ink`, `--graphite`, `--rule`, `--faint`, `--hair`, `--accent`, `--thread`, `--coroutine`, `--red`, `--switch-on`, `--thumb`, `--zone-fill`, `--ambient`, `--float`.
- Glass: `--glass`, `--glass-strong`, `--sheen`, `--rim`, `--gloss`, `--btn-glass`, `--btn-glass-hover`, `--btn-rim`.
- Legacy aliases (`--bg`, `--fg`, `--muted`, `--panel`, `--line`, `--sync`, `--ok`, `--warn`, `--error`, `--code-hit`, `--band-0..5`) resolve to the new tokens so older markup keeps working.

### Theme

- Dark is the default. The switch offers System, Light and Dark (`ThemeSwitch`, in the header).
- The choice is stored in `localStorage` under `insight-theme`. Every access is wrapped in try/catch. With nothing stored, the theme is dark.
- `index.html` sets `data-theme` on `<html>` before first paint. `theme.ts` applies later changes.
- The Cytoscape graph restyles from the tokens on theme change (MutationObserver on `data-theme` plus a `prefers-color-scheme` listener).

### Type

- UI stack: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter Variable", "Inter", system-ui, sans-serif`.
- Code stack: `ui-monospace, "SF Mono", SFMono-Regular, "JetBrains Mono", Menlo, monospace`.
- Inter and JetBrains Mono are self-hosted through `@fontsource-variable/inter` and `@fontsource/jetbrains-mono` (pinned), so the offline build ships them.
- Scale: `--t-xs` 11px, `--t-sm` 13px, `--t-md` 14px, `--t-lg` 17px, `--t-xl` 22px.

### Accessibility

- `prefers-reduced-motion`: transitions and animations are removed.
- `prefers-reduced-transparency`: glass becomes solid surfaces with no blur.
- `prefers-contrast: more`: ink outlines.

### Line types (the legend in the Layers panel)

- Process: thick ink.
- Thread: thin verdigris (`--thread`).
- Coroutine: dashed ochre (`--coroutine`).
- "No runtime context": dotted graphite.

### Motion

- Camera: one critically damped spring (response 0.42 s, 240 Hz substeps). It is interruptible: any input stops it.
- Drag: 1:1 with pointer capture after a 4px threshold. Release carries momentum using the projection `(v/1000)*0.998/(1-0.998)`, and the spring takes over the velocity.
- Wheel: zooms around the pointer (factor 0.01 with ctrl/pinch, else 0.0016).
- Level of detail: labels hide below k≈0.42.
- Reduced motion: the camera cuts, and details fade instead of sliding.

## Information architecture

| Today | Becomes |
| --- | --- |
| Flow tab | **Flow** mode, the sheet (default) |
| Arch tab | **Arch** mode, a layered folder graph in sheet style |
| Findings tab | **Findings** mode, a revision table |
| Overview tab | Title block on the sheet (bottom-right) and the Flow root. The full overview page stays reachable from Find. |
| Source tab | Source side panel (right; bottom sheet ≤860px). Opening a file from Files with nothing selected opens the panel with the file. |
| Lens tabs | Layers panel (bottom-left): toggles with counts. A lens with a full page opens it from Layers or Find. |
| Compare, Triage | Commands in Find (⌘K or `/`) |
| Explorer | Files drawer (toggle, also from Find) |
| Roots only switch | Layers panel toggle "Entry points only" (still the `roots` URL param) |

- Routes stay the same, so old links keep working: `#/projects/:id/view/<tab>?scope=&fn=&roots=`.
  - `overview` and `source` render the Flow mode with the title block highlighted, or with the source panel open on `scope`/`line`.
  - Lens ids still route to `LensPage` for the full-page view.
- `BUILTIN_TABS` in `router.ts:4` is unchanged. Only the shell's rendering changes.

## Flow mode in detail (the bulk of the work)

The engine stays. The current pipeline does not change:

- `ExecStore` → `MapSource` → `layoutScene` / `placeSceneLayout` (packages/flow);
- the ELK worker;
- LOD in `zoom/lod.ts`;
- expansions in `zoom/expand.ts`.

Flow mode is a restyle plus four additions.

### 1. Sheet frame

- A zone grid border with zones of 480 world units, columns numbered and rows lettered, origin at −160. It is drawn in world space, so it pans and zooms with the map.
- Selection and Find results show their zone reference ("C4") in the title block and in the panel header.
- New pure module `apps/web/src/zoom/zones.ts` with `zoneOf(rect)` and `zoneLines(view)`, unit tested.

### 2. Line types

- `edgeClass` and the box class in `zoom/source.ts` give runtime frames `process` / `thread` / `coroutine` / `none` classes.
- CSS draws them with the line types above. No layout change.
- Spawn edges are drawn thick with an open arrow, and dispatch edges dashed.

### 3. Lettered detail views (replace the expansion styling)

- An opened expansion is drawn as a **detail view**:
  - a callout ellipse around the function;
  - a letter bubble (A, B, C … in open order) with a leader line;
  - the detail frame to the right holding the chart, titled "Detail A: name".
- The chart uses ISO 5807 shapes: terminator for entry/exit, diamond for decision, hexagon for loop, process rect for steps.
  - `components/zoom/Expansion.tsx` and `components/FlowChart.tsx` change. The chart model (`FunctionFlow`) does not.
- **Columns to the right slide over** while a detail is open, so the callees stay visible.
  - This is a render-time shift, not a layout change. The layout stays fixed and shared, as Phase 3 of the execution canvas requires.
  - New pure function in `expand.ts`: `shiftOf(placed, pivotX, width) → dx`. Every placed item and edge point whose x is past the pivot is translated by the width of the open detail plus `EXPAND_GAP`.
  - The shift animates on the same spring as the camera and is interruptible. Closing the detail springs it back.
  - Nested step expansions add to the shift of their parent.
  - Edges get the shift per endpoint, so a call edge that crosses the pivot stretches.
  - Unit tests in `test/expand.test.ts`: items left of the pivot don't move; a nested chain sums; closing restores zero.
- Letters are per map session (reset when the scope changes). The URL keeps `fn` as now; letters are not in the URL.

### 4. Revision clouds

- When a findings layer is on, each function that has a finding of that kind gets:
  - a red revision cloud (a scalloped outline path around its box);
  - a numbered triangle marker. Clicking the marker opens that finding in the source panel.
- Data: findings already carry their function and line. They join to the scene by function id in a new `zoom/findingsLayer.ts`, which loads lazily when the layer is first turned on.

### Kept as is (restyled only)

- Click-to-open, no auto-focus, expansion to the right, the source panel following the chain (`FunctionSource.tsx`), roots-only (as "Entry points only"), the hidden `mode=hierarchy` / `mode=exec` URLs, the minimap (restyled as a "key plan" inset), the scope trail (moves into the title block's Scope row), and `ExecFunctionPanel` / `ExecContainerPanel`.
  - The panels move from below the map into the source side panel's "Details" section.
  - `FlowFolders` (the file table in `FlowView.tsx`) moves into the Files drawer.

### Camera

d3-zoom stays the input layer (wheel, pinch, drag, keys).

- Programmatic moves (Find, keys, fit, `revealCamera`) are driven by the spring instead of `d3-transition` (`ANIM_MS = 450` in `ZoomMap.tsx`). Each frame writes `zoom.transform`.
- Drag release adds momentum.
- This lives in `apps/web/src/zoom/spring.ts` (pure stepper, unit tested), with a small `useCameraSpring` hook.
- No spring starts from a click (no auto-focus rule).

## Arch mode

- Restyle only. `components/views/ArchView.tsx` and `arch/layout.ts` keep their layout.
  - Folders are drawn as sheet frames, layers as labelled bands.
  - Edge width is the log of the call count, with count labels on a sheet-coloured background.
  - Fonts: name 23 / sub 16 / count 15 / layer label 17 (world units at k=1, as in the POC).
- Clicking a folder opens it in Flow (scope = folder).

## Findings mode

`components/views/FindingsView.tsx` becomes a revision table. There is one row per finding kind, showing:

- a count;
- the top files with proportional bars;
- three examples, each linking to Flow with `fn`;
- **Show in Flow**: turns on that kind's layer and switches to Flow with the clouds visible.

Message templates fill `{subject}` and `{n}` from the finding's data. No raw placeholders reach the screen. This fixes a current bug as well.

## Phases

Each phase is one `build/*` branch and one PR, with screenshots in the PR. The user approves each phase before the next starts.

### Phase 1: tokens, type, theme

- `styles.css`: replace ad-hoc colours with the tokens, add the dark theme and the font imports (self-hosted copies for the demo).
- Add a theme switch (system / light / dark, stored in `localStorage`, with try/catch).
- `components/GraphCanvas.tsx`: Cytoscape style reads the tokens via `getComputedStyle` and restyles on theme change.
- Accept when every existing page renders in both themes with no hard-coded colour left in `styles.css` (grep for `#` outside `:root`), and the lens graphs follow the theme.

### Phase 2: shell

- `components/Workspace.tsx`:
  - top bar (project, scope crumbs, modes Flow / Arch / Findings, Find, Files, theme);
  - full-height stage;
  - Layers panel, title block and source side panel as overlay components.
- New components in `components/sheet/`: `TopBar.tsx`, `ModeSwitch.tsx`, `FindPalette.tsx`, `FilesDrawer.tsx` (wraps `Explorer`), `LayersPanel.tsx`, `TitleBlock.tsx`, `SidePanel.tsx` (hosts `SourcePanel` / `FileViewer` and the exec panels).
- The route mapping as in the IA table. `overview`, `source`, `compare`, `review` and lens tabs still resolve.
- Find: fuzzy search over functions (from `ExecStore`), folders and files (from `files`), plus commands (Compare, Triage, Re-index, Overview, theme, Files). Keys are ⌘K and `/`; Esc closes.
- Accept when:
  - every old URL in the router tests still lands on the right content;
  - Find opens and reaches each target;
  - keyboard only works for all of it;
  - there is no horizontal scroll at 390px.

### Phase 3: Flow sheet

- 3a: zone grid, title block contents, line types, key-plan minimap, LOD tuning.
- 3b: lettered detail views, ISO 5807 chart shapes, side shift (`shiftOf`), source panel follows the chain as before.
- 3c: camera spring and momentum (`spring.ts`), replacing `d3-transition` moves. Check that no gesture triggers a camera move.
- 3d: revision-cloud layer and markers.
- Accept when:
  - the existing zoom tests pass (expand, gesture, lod) plus the new zones / shift / spring tests;
  - Playwright on the demo shows: open a thread, open a function (detail A, columns shift right), open a call step (detail B, further shift), close B (shift settles back to A's), click a box (no camera move).

### Phase 4: Findings and Arch

- Revision table, Show in Flow, filled message templates, and the Arch restyle.
- Accept when every finding kind with results has a row, Show in Flow lands on Flow with clouds drawn for that kind, and Arch fits on open with readable labels at fit scale.

### Phase 5: phones

- At ≤860px the source panel is a bottom sheet (drag with snap points at 40% and 90%, momentum projection, rubber band at the top). The title block and Layers hide while the sheet is open.
- At ≤520px the crumbs collapse and the mode counts hide.
- Accept when a Playwright run at 390×844 shows no horizontal scroll, the sheet drags and snaps, and Esc or a downward swipe closes it.

## Gate for every phase

- `pnpm -r --workspace-concurrency=1 build` and `pnpm -r test` pass.
- Demo build plus a Playwright screenshot set (desktop light, desktop dark, phone) attached to the PR. Use the headless Chromium recipe already used for this repo.
- No console errors on the demo pages.
- Bundle size noted in the PR (fonts are the main addition).

## Risks

- **Side shift and edge routing.** ELK edge bend points past the pivot must shift with their items. Edges that cross the pivot stretch their first segment.
  - If that looks wrong on dense scopes, fall back to fading the overlapped columns.
  - Measure on the root scope (1749 functions).
- **Performance.** Cloud paths and zone lines must be culled with the existing `CULL_MARGIN` logic.
  - The shift must not re-render React per frame. Write the transforms to the `<g>`s directly, as the camera does today.
- **Discoverability.** Moving Compare and Triage into Find hides them.
  - The top bar shows a "Find" button with the shortcut, and Find opens with commands listed when empty.
- **Fonts offline.** The offline build (`serve-offline.mjs`) must ship the font files.
- **Overview and Source links in docs or the demo.** These are covered by the route mapping. Check the capture script's links.

## Out of scope

- Any change to the exec model, scene layout, parsers or server routes.
- The Lock order layer has no data yet. The Layers panel shows it disabled with "no data".
- Deploys. They happen when the user asks.
