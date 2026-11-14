# System tab and runtime-resource model

## Goal

Provide a first-class **System** tab that explains the running system—not just package dependencies—using boxes and relationships for processes, threads, coroutines, disk access, kernel/system-call access, network services, child processes, and other grounded runtime resources.

## Existing foundations

- `apps/web/src/components/views/ArchTab.tsx` already contains a System mode; `SystemView.tsx` and `packages/core/model/src/system.ts` currently render components, routes, external services, filesystem, process execution, config, and workers.
- `packages/core/flow/src/exec-model.ts` already derives programs, threads, spawn facts, and coroutines from concurrency IR.
- The IR defines concurrency and effects facts, but the current `SystemModel` groups runtime concerns mostly as component-to-external edges. Kernel/system-call representation and a runtime hierarchy are incomplete.

## Implementation steps

1. Audit the existing Arch/System mode against the desired tab information architecture. Decide whether “System” remains the Arch default mode or becomes a top-level workspace tab; update routing, URL compatibility, tab labels, keyboard/accessibility behavior, and documentation without creating two divergent views.
2. Write an IR coverage matrix for each requested concept: process, thread, coroutine, file/disk operation, network, child process, kernel/system call, environment/config, worker/message boundary. For each, mark current node/edge kinds, frontend emitters, provenance, and display behavior.
3. Extend IR kinds/facet schemas only where existing facts cannot express the concept. Prefer a generic, extensible `effects.kernel.*` or an explicit syscall attribute on an effect over frontend-specific names; include operation/API, resource/target, ownership, span, and exact/inferred provenance. Update the IR reference and registry validation.
4. Update TypeScript, C++, and relevant build frontends to emit the new facts when statically provable. Preserve unknown/dynamic targets as honest unknown effects, and do not infer system calls merely from arbitrary function names. Add focused golden NDJSON fixtures per frontend.
5. Evolve `SystemModel` into a runtime-aware graph: model process/thread/coroutine containers and resource boxes, attach code components to their runtime owners, and aggregate evidence into labelled edges with site links and confidence. Specify the degradation path when the concurrency/effects facets are unavailable.
6. Extend `system-layout.ts` and `SystemView.tsx` to lay out the hierarchy/read order (program/process → thread → coroutine → component/function → resource), with compact aggregation and progressive expansion for high-cardinality systems. Reuse existing pan/zoom, selection panel, source links, and test toggle.
7. In the details panel, expose the exact evidence for each box/edge: API/syscall, resource or command, count, confidence, and source sites. Make the distinction between a literal syscall, a high-level API, and an inferred/unknown effect legible.
8. Update demo capture/static payloads, server/hosted parity, docs (`system-view.md`, `ir-reference.md`, and navigation docs), and migration behavior for stored snapshots that predate the added facts.

## Tests and acceptance criteria

- Add model fixtures covering a main process, child process, worker thread, coroutine/await chain, read/write filesystem operations, network call, environment read, and a literal/dynamic kernel-facing operation.
- Verify stable graph IDs, deterministic aggregation, scoped views, unavailable-facet degradation, source-site caps, and exact versus inferred confidence.
- Add System view interaction tests for hierarchy expansion, selection/details, keyboard access, pan/fit, and links to the owning function/source.
- Check schema validation, frontend golden output, server/static/hosted payload parity, and a migration read of an old serialized model.
- The final view visibly separates runtime containers and resources while still answering “which code caused this effect, where, and with what confidence?”

## Risks / decisions

- “Kernel access” needs a precise taxonomy before implementation. The plan should first define whether it means explicit syscall APIs only, OS-facing operations broadly, or both; default to the narrow, evidence-based meaning.
- Keep the system graph aggregated by default. One box per call site would make real projects unreadable.
- Runtime placement inferred from calls must be labelled inferred; only spawn/dispatch facts ground process, thread, and coroutine boundaries.
