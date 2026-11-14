# States lens

## Goal

Add a `lens-states` plugin that extracts explicit state machines from the IR and presents a navigable state diagram. It must report what it can prove, distinguish inferred transitions, and say when the indexed code does not contain a recognizable state model.

## Existing foundations

- Lenses are isolated plugins under `packages/lens/*`, consuming `IRView` and returning graph/table views as described in `docs/writing-a-lens.md`.
- The IR already records structure, calls, flow branches, effects, concurrency dispatches, and source spans; graph views render in the lens page.
- Existing lenses (especially `lock-order`, `calls`, and `concurrency-map`) establish patterns for manifests, fixtures, stable finding ids, metrics, scoped execution, and uncertainty.

## Implementation steps

1. Define the supported state-machine evidence before writing the lens. Start with explicit finite-state patterns that can be represented reliably in the existing IR: enum/string/discriminant comparisons, assignments to the same state holder, and transitions performed in named handlers/functions. Record unsupported idioms (dynamic property keys, reflection, arbitrary mutation) as limitations.
2. Audit the current IR for the required facts: declarations/types or enum members, reads/comparisons, assignments/writes, branch ownership, call context, and spans. Add narrowly scoped IR kinds/attributes and TypeScript/C++ emitters only for missing facts; avoid having the lens re-parse source.
3. Create `packages/lens/states/` with package metadata, `insight-plugin.json`, public exports, and a `Lens` whose `requires`/`optional` facets truthfully express its evidence. Register it in every loader/hosted dependency list and ensure the plugin-discovery/layout checks cover it.
4. Build a deterministic extractor that groups facts by state holder/type, identifies states and transitions, attaches guard/event/action labels where proven, and preserves source node ids/spans. Derive stable state and transition ids from the owner plus normalized state values.
5. Represent uncertainty explicitly: exact assignment plus exact discriminant is exact; a path through indirect calls, unbounded dynamic values, or candidate dispatch is inferred/unknown. Do not manufacture an edge for a state value that the IR cannot name.
6. Return a graph view for the diagram and a companion table for transitions/evidence. Add metrics for machines, states, transitions, exact/inferred/unknown counts, and skipped/dynamic candidates. Emit findings only for actionable anomalies (for example unreachable declared state or transition to an unknown declared value), not for every machine.
7. Design scoped behavior: retain boundary stubs and label transitions entering/leaving the selected scope, following the established scoped-IR conventions. Ensure the result cache inputs include every facet the extractor reads.
8. Add Lens page affordances to select a state/edge, inspect evidence and confidence, and jump to source. Confirm current graph rendering is sufficient; extend the renderer only if graph-view labels/edge styles cannot carry the required information.
9. Document the supported source patterns, IR contract, configuration (if any), confidence model, scope behavior, and false-positive/false-negative boundaries in `docs/writing-a-lens.md` examples or a new dedicated guide.

## Tests and acceptance criteria

- Unit-test fixtures for a simple reducer, guarded transition, self-transition, terminal state, multiple machines, an indirect/dynamic write, recursion/callback transition, and scoped boundary edges.
- Assert stable ids and output ordering, exact/inferred labelling, metrics, no-results behavior, cache reuse/invalidation, and unavailable-required-facet behavior.
- Add end-to-end tests that index a representative TypeScript fixture, run the lens, render the graph/table, select a transition, and follow its source link.
- A supported reducer-like program produces a diagram whose nodes and labelled edges match the IR evidence; an unsupported dynamic program clearly reports limited evidence instead of a misleading complete diagram.

## Risks / decisions

- State extraction is intrinsically heuristic outside explicit patterns. Ship a deliberately narrow first dialect with transparent confidence rather than a broad but unreliable analysis.
- Decide early whether “state” includes protocol/lifecycle states inferred from effects; keep that as a later extension unless it has explicit IR evidence.
- A graph view is the right first presentation because tree views are not rendered by the current lens page.
