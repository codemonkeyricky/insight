# Flow callers button: outstanding work

PR #69 (`build/flow-callers`, head 27dec63 when this was written) adds the `◂ callers` chip to the Flow tab's zoom map. Three Opus review rounds ended in "merge". A fresh, independent Opus review of 27dec63 then said **merge after fixes**. This file lists what is still open, so the next session can finish the PR.

Status: nothing below is done. Items 1–3 must be fixed before merge. The rest can land in this PR or in a follow-up.

## Before merge

### 1. Escape on a card's callers box walks the map up a level (minor)
- Where: `apps/web/src/components/zoom/ZoomMap.tsx` ~1259, the Escape handler.
- Defect: the "hangs from the selected box" branch also matches a box-anchored callers box, so it runs `show(parent)`.
- Scenario: click card F (opens + selects). Click F again to close its chart; F stays selected. Click F's `◂ callers`, then press Escape. The callers box closes, but the map also goes up a level and refits the camera.
- Fix: add `last.kind !== "callers"` to that branch, so Escape only closes the callers box.

### 2. `hangCallersFrom` closes the chart's own children (minor)
- Where: `apps/web/src/zoom/expand.ts` ~262-277.
- Defect: the docstring says the chart's own children are not closed, but `closeSiblings(list, kept.fnId, headerAnchor(head))` closes every step child of `ref`.
- Scenario: open callers on card F. Open F as a callee in G's chain, then open F's callee H. Click card F: F reattaches to its card and H closes without warning.
- Fix: decide the behaviour, then make the code, the docstring and the M2 test agree. Preferred: keep the reattached chart's children and give the callers box a slot that doesn't overlap them (for example, stack it above the step child). Fallback: keep closing them, but correct the doc.

### 3. Card chip hidden while the function's chart is open anywhere (minor)
- Where: `ZoomMap.tsx` ~1544.
- Defect: the card chip is gated on `expandedFns.has(node.ref)`, which is true when F's chart is open anywhere, not only on this card.
- Scenario: a callers box still hangs on the card, but its chip is gone, so the box has no toggle and no open-state indicator.
- Fix: gate the chip on `anchoredTo(expansions, it.id)`, meaning the chart is open on this card.

## Should fix (this PR or a follow-up)

### 4. Wrong async frame on a caller chart (minor)
- Where: `ZoomMap.tsx` ~1428 (asyncFns).
- Defect: a caller chart opened from a callers row walks `rootBoxOf` through the callers box to the card. `asyncOf(view, caller, root)` then tests it against a thread the caller isn't part of.
- Scenario: a caller that is a dispatch target in the card's thread gets a dashed async frame it shouldn't have.
- Fix: stop `rootBoxOf` at callers boxes for this check, or treat a chart hung from a callers row as not async.

### 5. Click race between caller rows (minor)
- Where: `openCallerChart` / `openStep` (`ZoomMap.tsx` ~730, ~820).
- Defect: the guards check context and that the parent is still open, but not click order.
- Scenario: click ▸ on row A, then quickly on row B. Whichever chart loads last opens, which can be A.
- Fix: keep a per-parent sequence token and drop superseded loads. Add a test.

### 6. Chip text overflows its pill when zoomed out (minor)
- Where: `apps/web/src/styles.css`, `.zm-callers-btn text`.
- Defect: the font is `max(11px, 11px*zinv)`, but the pill is a fixed 78×22 world units, so the text overflows below about 0.7× zoom.
- Fix: hide the chip below a scale threshold (the way names are fitted), or scale the pill with the text. Check at 0.5× and 0.3×.

### 7. Focus lost after Escape or a sibling close (minor)
- Defect: only the × returns focus to the stage. If Escape or a sibling close removes the box holding the focused row or ▸, focus drops to `body` and map keys stop working.
- Fix: refocus the stage on those paths too, but only when focus was inside the removed box (don't steal it from the Code pane or an input).

### 8. Connector points at the wrong row after rows reload (minor)
- Defect: a caller chart is anchored by `callerRowRect(index)`. If the rows reload in a different order (lambda toggle, rescan), the connector points at the wrong row.
- Fix: anchor by `row.id` and re-resolve the index when the rows change. If the row is gone, close the chart.

## Nits and cleanup

### 9. Tests don't cover the map wiring
- The M1 tests exercise `refusedCallersPlan` / `loadFunctionChart`, helpers that exist only to be tested.
- Nothing tests the ZoomMap wiring: `toggleCallersOf`, `openCallerChart`'s chain refusal, `show()` followed by `hangCallersFrom`, chip visibility, or Escape.
- The ↺ DOM test injects `inChain` directly.
- Add a ZoomMap-level harness (or a thin, testable controller extracted from ZoomMap) and cover items 1–3, 5 and 7.

### 10. Quality
- The `"callers:"` literal and `.slice("callers:".length)` appear about 6 times. Add `isCallersKey(key)` / `refOfCallersKey(key)` / `callersKey(ref)` helpers in `zoom/callers.ts` and use them everywhere.
- `onClick` on the `.zm-caller-name` text never fires, because it has `pointer-events: none`. Remove the handler, or move it to the row hit area.
- A closing CallersBox renders without rows, so the rows vanish when the fade-out starts. Keep the last rows during the close animation.
- `readLambdas()` isn't reactive.
- `reflow` builds a new anchor object for header boxes on every pass. Reuse it when nothing changed.

## Known gaps (accepted for now)
- A second relayout happens when the caller count isn't 3: the loading state reserves 3 rows, so the box resizes once.
- The chip has no count ("◂ N").
- Open callers boxes aren't saved in the URL.
- `openExpansion` rebuilds a reattached expansion from the `chart` argument and drops `kept.base`/`inline`, so nested frames are lost when it reattaches. This predates the PR.
- A refused hop inside `showChain` now reveals and selects, so the camera and selection can move mid-chain. Confirm this is wanted.
- Not checked in a browser:
  - keyboard focus rings
  - a module ("top level") row opening the file in the Code pane
  - whether the "Show" button overlapping a card header at top-left predates this PR

## Done when
- Items 1–3 are fixed, each with a test that fails without the fix. Items 4–10 are fixed or explicitly deferred in this file.
- `pnpm -r --workspace-concurrency=1 build`, the web typecheck and `pnpm -r test` pass.
- A browser check on a test server (not :4317) against `~/deploy/cognition`, at `src/verify/verify.ts#verifyFull`, in dark, light and 390 px. Re-shoot `docs/screenshots/flow-callers/`, including Escape on a card's callers box and a 0.5× zoom shot. No console errors and no 4xx responses.
- A final Opus review returns only nits. The PR description is updated (it still describes the first version: 7 tests, 916 web tests). The PR is marked ready.
