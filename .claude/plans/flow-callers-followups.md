# Flow callers button: follow-ups

PR #69 (`build/flow-callers`) adds the `◂ callers` chip to the Flow tab's zoom map. This file listed what was still open
after the earlier review rounds. An independent Opus review of 6ef46d3 then confirmed most items and found four more. All
items are now fixed or explicitly deferred below.

## Fixed

| # | Item | Fix | Test |
|---|------|-----|------|
| 1 | Escape on a card's callers box walked the map up a level | The "hangs from the selected box" branch skips `kind: "callers"` | `flowCallersMap.dom.test.tsx` (item 1) |
| 2 | `hangCallersFrom` closed the reattached chart's children against its doc | Decided: the chart's own callees win. A chart with a right-hand child keeps it and the card's callers box closes; otherwise the box moves to the header. Code, doc and test agree. | `flowCallers.test.tsx` (M2, two cases) |
| 3 | The card chip was hidden while the chart was open anywhere | Gated on `anchoredTo(expansions, it.id)` (a chart on this card) | `flowCallersMap.dom.test.tsx` (item 3) |
| 4 | Async frame on a caller's chart | `hangsFromCallers`: a chart reached through a callers box (and its callees) gets no async frame. The review judged this a wording question; kept as the conservative reading. | `flowCallers.test.tsx` (item 4) |
| 5 | Click race between rows (and between call steps) | `LatestLoad` (`zoom/latestLoad.ts`): a per-parent token; a callers toggle on a step supersedes a pending callee load there | `flowCallersMap.dom.test.tsx` (item 5) and a unit test |
| 6 | Chip text overflowed its pill when zoomed out | Below 0.82× the chip is compact (◂ alone, 26 wide, right-aligned in its slot); below 0.45× it is hidden. Browser-checked at 1.3×, 0.77×, 0.51× and 0.34×. | `flowCallers.dom.test.tsx` (zoom) |
| 7 | Focus lost after Escape or a close | `setExp` refocuses the stage after the re-render only when the focus was in the map and is now lost; the ↺ path no longer steals focus | `flowCallersMap.dom.test.tsx` (item 7, both directions) |
| 8 | Connector pointed at the wrong row after rows reloaded | `syncCallerRows`: caller charts follow their row by caller id; a gone or capped row closes its chart. CallersBox reports the row ids with its size. | `flowCallers.test.tsx` (item 8) |
| 9 | No test reached the map wiring | `flowCallersMap.dom.test.tsx`: ZoomMap mounted in jsdom with a fake source. Each fix's test fails with that fix reverted. The "never takes the focus from outside the map" test only guards the `stage.contains` condition (it passes on the old code too). | |
| 10 | Quality | `callersKey`/`isCallersKey`/`refOfCallersKey` in `zoom/callers.ts`, used everywhere; dead `onClick` removed; a closing box keeps its last rows (a small per-key cache, also used when a box reopens); `reflow` reuses an unchanged header anchor. `readLambdas()` needs no reactivity: the Flow view remounts the map when Lambdas changes, so the read is keyed into the rows cache. | |
| R4 | `docs/zoom-map.md` said opening a card's chart closed its callers box | Paragraph rewritten (one right-hand child, header move, fold, async frame, zoom) | |
| R5 | A callers box on a nested frame was orphaned when the frame folded | `setInline` closes a callers child whose step is no longer `nest`/`fork` | `flowCallers.test.tsx` (review 5) |
| R6 | Double-clicking a chip, a callers box or a × zoomed the map | `zoomTakes` leaves dblclick on `.zm-callers-btn, .zm-callers, .zm-expansion-close` to the control | `gesture.test.ts` |
| R8b | ↺ moved the focus to the stage | Removed | |
| R10 | Nested frame label ran under the chip | The label is cut to the room left of the chip (full name in the tooltip) | `flowCallers.test.tsx` |

Found in the browser check (not in either review):
- Roots-only cards (160 units wide) lost their names entirely: the full chip left fewer than the minimum characters.
  Now a card whose name would not fit whole beside the full chip gets the compact chip. Test in `flowCallers.test.tsx`.
- The callers box's row text was fitted at the screen scale, but its fonts are in world units, so a note ran past the
  box's edge. Rows are now fitted to their world width with measured character widths.
- A chart header's name was fitted without the ×'s room, so on a phone it ran into the chip.

## Second Opus review (of the fixes above)

| # | Finding | Fix | Test |
|---|---------|-----|------|
| 1 | The call-step race was still open: `inlineStep` awaited the callee with no token | `inlineStep` starts the load token before its await and passes it to `openStep` | two map tests (chevron path; a callers box opened while a callee loads) |
| 2 | A chart could open beside a row the fresh rows no longer had | The map keeps each box's last row ids; `openCallerChart` places the chart at its row's current index, or opens nothing | map test (reopen with cached rows, then fresh rows without A) |
| 3 | A toggle that closed or was refused cancelled a pending callee load | The token is taken only when the box opens or moves onto the chart | map test |
| 4 | Card names overflowed above about 1.2× (the font grows with the zoom there) | The fit's character width follows the font: `max(8, 6.8k)` px | `flowCallers.test.tsx` at 1×, 2×, 3× |
| 5 | Focus restore ran in a frame that could come before the commit; a row gone after a refetch was not covered | Restore in a layout effect after the commit; CallersBox reports a focused row lost when its rows change (`onFocusLost`) | map and DOM tests |
| 6 | Item 7's tests covered only the closing box and outside focus; `chartBox` matched leaving copies | Added "focus stays on a surviving box's ▸" and the keyboard × path; `chartBox` skips `.is-leaving` | |
| 7 | The closing copy showed rows from an earlier open after a failed fetch | The cache keeps what the open box showed (rows, error or loading), recency is refreshed on reads, and a new key starts from its cached rows | DOM test |
| 8 | Labels reserved the full chip's room when it was compact or hidden | `callersChipW(k)` gives the chip's real width to the header and frame label fits | |
| 9 | The doc said "a callee" where any right-hand box counts | Doc wording | |
| 10 | The R6 test faked `closest` | A jsdom test with real elements | `flowCallers.dom.test.tsx` |

## Known gaps (accepted)
- The chip has no count ("◂ N"). Open callers boxes aren't saved in the URL.
- A box that opens for the first time reserves 3 rows while it loads, so it resizes once when the count differs.
- `openExpansion` rebuilds a reattached expansion from the `chart` argument and drops `kept.base`/`inline`, so nested
  frames are lost when it reattaches. This predates the PR.
- The nested frame's chip lives in FlowChart's `<svg role="img">`, whose children are presentational to screen readers,
  like the existing chevron. The beam from a nested-frame callers box spans the frame's height.

## Browser check
A test server on :4400 against a copy of `packages/core/flow` (`~/deploy/cognition` isn't available in the cloud
session), in dark, light and 390 px. The flow covered: open callers from a chart header, open a caller's chart from its
row, continue the chain from that chart, press Escape with focus in the last box, and zoom out step by step. There were
no console errors and no 4xx responses. Screenshots are in `docs/screenshots/flow-callers/` (c0 cards, c1 box, c2 caller
chart, c3 chain, c4 after Escape, c5 zoomed out, c2-light, c2-phone).
