# Reverse symbol lookup

## Goal

Let a reader start from any resolved symbol (for example, `validatePhysicsModel`) and explore its complete incoming call chain: direct callers, callers of those callers, and so on. The result must be bounded, cycle-safe, source-linked, and explicit about unresolved or candidate dispatches.

## Existing foundations

- `packages/core/model/src/refs.ts` (exported through `refsOf`) and `apps/web/src/model/payloads.ts` already provide one-hop `calledBy` data.
- `apps/web/src/components/zoom/RefLists.tsx` renders the selected function's direct callers and can link each function into Flow.
- `calls.call` supports exact and candidate targets; `IRView.trace` already has traversal and uncertainty semantics.

## Implementation steps

1. Define a model-level reverse-call query in `packages/core/model`, rather than recursively fetching UI reference rows. Its input should be a symbol id and options (`maxDepth`, `maxNodes`, scope policy, candidate policy); its output should be a deterministic tree/graph with per-node depth, source location, incoming-edge metadata, and truncation/cycle markers.
2. Build the reverse adjacency from `calls.call`, and include the currently represented dispatch/reference relationships only when the UI labels them distinctly. Follow candidate targets only when the user opts into “possible callers”; retain confidence and candidate/truncated flags on every branch.
3. Treat a symbol reachable through several paths as one canonical node with multiple incoming edges. Stop a branch that re-enters an ancestor; report the cycle instead of recursively expanding it. Cap the result by depth and node count, and return a clear continuation/truncation reason.
4. Expose the query through the same live/static/hosted API contract used by `getRefs`, including scoped behavior. A lookup from a file/folder must distinguish callers inside the scope, outside the scope, and external/unresolved origins rather than silently dropping them.
5. Add a “Callers” explorer to the function detail/RefLists UI. Start collapsed to direct callers, provide per-node expand/collapse and “expand all to depth N” controls, preserve the existing direct-reference panel, and use existing Flow/code URLs for every concrete function.
6. Support symbol discovery from the Find palette and selected function cards: display qualified name, file and declaration line so duplicate short names cannot be confused. Define the lookup target as an IR symbol id, not a textual name.
7. Add empty, unresolved, candidate-only, external-caller, recursion, multiple-path, and capped-result states. Avoid claiming a chain is exhaustive when the IR has dynamic/unresolved calls.

## Tests and acceptance criteria

- Unit-test the model query with a chain (`A → B → validatePhysicsModel`), a diamond, a self/mutual recursion cycle, exact and candidate calls, external stubs, and each cap.
- Add API/static parity tests so server, demo/static API, and hosted paths return the same payload shape and ordering.
- Add React tests for initial collapse, incremental expansion, source/Flow navigation, candidate labels, cycle markers, and an accessible tree keyboard interaction.
- A reader can select `validatePhysicsModel`, see every indexed direct caller, expand repeatedly to its configured depth, and navigate to each caller without losing scope context.

## Risks / decisions

- The first release should be symbol-id based; fuzzy name search is only a selection aid.
- Keep a conservative default cap (chosen after fixture sizing) and expose it in the UI. A full-project reverse graph can otherwise be extremely large.
- Candidate dispatches are possible, not proven, callers; they must never be merged visually with exact calls.
