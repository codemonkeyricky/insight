# Fold loops by default

## Goal

Render loop bodies closed when a function flow chart first opens, with an obvious control to expand or collapse each loop. Preserve the current interaction model for nested calls, branches, and source navigation.

## Existing foundations

- The IR has `flow.loop` nodes and structured flow facts.
- `@insight/flow` produces chart layouts; `apps/web/src/components/FlowChart.tsx` already renders `nest` frames and exposes chevron/keyboard folding through `onNodeOpen`.
- Flow expansion state is held in the zoom-map layer, so the default must be applied when constructing a fresh chart, not by mutating source IR or persisting an accidental per-session state.

## Implementation steps

1. Trace `flow.loop` from frontend extraction through `packages/core/flow` layout/scene types and identify the loop's header, contained steps, exit/back edges, and nested-loop boundaries. Add fixtures wherever current extraction fails to preserve that containment.
2. Add a layout-level fold representation for loops (for example a compact loop header with a hidden-subtree summary) alongside the existing nested-call representation. The folded form must retain incoming/outgoing/back-edge attachment points so no false control-flow path is drawn.
3. Make loop frames closed by default when a chart is first built. Keep expansion state local to the displayed chart and key it by stable flow-node id, so reopening a chart gets the default while explicitly opened loops remain open during a live interaction.
4. Reuse the FlowChart chevron, double-click, Enter, and Space behavior for loop headers; supply clear accessible names such as “Open loop …” / “Fold loop …”. Include a compact label with iteration/contained-step information when it is available.
5. Specify nested behavior: opening an outer loop reveals its immediate content but inner loops remain closed; folding an outer loop removes any visible descendant state safely. Calls inside a folded loop must not be independently expandable until their loop is open.
6. Verify camera fitting, inline call details, selection, animated tokens, and links to source lines after re-layout. Reduced-motion behavior must remain unchanged.
7. Document the default and controls in `docs/zoom-map.md`, including the difference between a loop frame and the existing call-frame fold.

## Tests and acceptance criteria

- Add flow-layout unit fixtures for `for`, `while`, nested loops, loops with `break`/`continue`, an early return, and a loop that contains a call/await.
- Assert initial layout hides loop descendants, has valid edge endpoints, and opening/folding is deterministic and restores the initial geometry.
- Add component tests for chevron click, keyboard controls, nested-loop behavior, source selection, and no inaccessible hidden focus targets.
- On opening any function with a loop, the chart shows a compact loop header first; expanding it reveals the correct body and control-flow edges without moving unrelated expanded call panels incorrectly.

## Risks / decisions

- Use structural containment from the flow IR, not screen-position heuristics.
- Do not collapse branches or try/catch constructs in this change; their defaults remain as-is.
- Establish one small visual fixture before tuning the summary text, padding, and animation so the data contract remains stable.
