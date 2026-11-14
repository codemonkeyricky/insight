# States lens

## Goal

Add a `lens-states` plugin that finds explicit finite state machines in the IR and draws each one as a state diagram
(states, labelled transitions, start, "any state") with a companion evidence table. It reports only what the IR can
show, marks inferred transitions, and says plainly when the indexed code holds no recognisable state model.

The first dialect is deliberately narrow: **a field or variable whose declared type is a finite set of values** (an enum
or a union of literals), written with values the type checker can name, and tested with `===`/`!==`/`switch`. In this
repo that already covers `ProjectRecord.status` (`idle → indexing → idle | error`, `apps/server/src/jobs.ts:192,247,252`),
`ReviewStatus` (`packages/core/indexer/src/review.ts:8`) and `IndexPhase` (`packages/core/indexer/src/pipeline.ts:20`).

The States tab must draw a **real state-machine diagram**: rounded state boxes with the name inside, a filled start dot,
labelled directed arcs, self-loops, and inferred arcs dashed. A dot-and-line force graph doesn't count (D10).

Changing the IR is allowed (user, 2026-11-14).

## Example repos (acceptance targets)

Found by web search and read at source on 2026-11-14 (`main` / `develop` HEAD; pin a commit sha in P0).

**Primary: the SignalR TypeScript client.** `dotnet/aspnetcore`, folder `src/SignalR/clients/ts/signalr/src`. The
monorepo is huge and mostly C#, so index only that folder from a sparse clone:

```sh
git clone --depth 1 --filter=blob:none --sparse https://github.com/dotnet/aspnetcore
git -C aspnetcore sparse-checkout set src/SignalR/clients/ts/signalr
```

Then run `insight serve` on `aspnetcore/src/SignalR/clients/ts/signalr`. The hosted path can't take it: the tarball is
the whole monorepo.

- `HubConnection.ts`: `export enum HubConnectionState { Disconnected, Connecting, Connected, Disconnecting,
  Reconnecting }`, all string-valued. Every write is a direct `this._connectionState = HubConnectionState.X`. The writes
  are:
  - init `Disconnected` (constructor);
  - `_startWithStateTransitions`: early exit `!== Disconnected` → write `Connecting`, then `Connected` in the `try` after
    an `await`, and `Disconnected` in the `catch`;
  - `_stopInternal`: early exits `=== Disconnected` and `=== Disconnecting` → write `Disconnecting`;
  - `_completeClose`: write `Disconnected` under a non-state guard;
  - `_reconnect`: write `Reconnecting`, then early exits `!== Reconnecting` after awaits, then write `Connected`;
  - `_connectionClosed` branches on `=== Disconnecting` and `=== Connected`, then calls `_completeClose` and
    `_reconnect`;
  - comparisons such as `(this._connectionState as any) === HubConnectionState.Disconnecting` use `as any` casts.
- `HttpConnection.ts`: `const enum ConnectionState { Connecting, Connected, Disconnected, Disconnecting }` (private, not
  exported). The writes are:
  - init `Disconnected`;
  - `start()`: early exit `!== Disconnected` → `Connecting`;
  - `stop()`: early exits `=== Disconnected` and `=== Disconnecting` → `Disconnecting`;
  - `_startInternal`: `if (=== Connecting) { … = Connected }`, and `Disconnected` in its `catch`;
  - `_stopConnection` writes `Disconnected` and is called from `stop` paths and from transport `onclose` callbacks.

Expected `HubConnectionState` diagram (P5 checks this; P0 confirms or corrects it from the real index):
- `● → Disconnected`;
- `Disconnected → Connecting` (start);
- `Connecting → Connected`;
- `Connecting|Connected → Disconnected` (catch);
- `Connecting|Connected|Reconnecting → Disconnecting` (stop);
- `Disconnecting → Disconnected` (`_completeClose`, inferred via the caller's branch);
- `Connected → Reconnecting` (inferred via `_connectionClosed`);
- `Reconnecting → Connected`.

This is hand-traced from source, not taken from docs; P0 is where it gets confirmed.

**Secondary: stompjs.** `stomp-js/stompjs`, `src/client.ts` + `src/types.ts`, small enough for the hosted path
(`/stomp-js/stompjs@develop`).
- `enum ActivationState { ACTIVE, DEACTIVATING, INACTIVE }`, numeric. The field initialiser is `INACTIVE`, and every
  other write goes through the setter `_changeState(state) { this.state = state; this.onChangeState(state); }`, called
  as `this._changeState(ActivationState.ACTIVE)` and so on. That needs D4(e).
- The only wrapping guard is `if (this.state === DEACTIVATING) _changeState(INACTIVE)`. The rest are early exits, some
  through the getter `get active() { return this.state === ACTIVE }`, which is not followed (limit).
- A second field `_intendedState: ActivationState` is a second machine.

**Third: this repo** (`ProjectRecord.status`, object-literal patches).

## Where we start (facts, with file:line)

**The IR has no state facts.** It records no write to a field or variable, no value, no comparison, and no enum
member (`docs/ir-reference.md:60-112`, `packages/core/ir/src/facets.ts:2-10`). Step 2 of the old plan ("add facts only
where missing") is therefore most of the work. The lens cannot be built on today's IR.

What exists and can be reused:
- **TS branches** (`packages/frontend/typescript/src/extract.ts:1600-1612`): `flow.branch` stores `condition` as text cut
  to 200 chars. `flow.switch` stores only `hasDefault`, with no discriminant. Each `flow.branch-arm` stores a `label`
  (`then`, `else`, `case <text cut to 60>`, `default`) and a span. Nothing is structured enough to pull out a value.
- **TS types** (`extract.ts:157-160`, `:1238-1247`): `structure.type` stores `name` and `typeKind`
  (`class|interface|enum|alias`). It stores no members and no union values.
- **The type checker is already used by the frontend**: contextual types of object literals at
  `packages/frontend/typescript/src/dispatch.ts:167`, and symbol resolution at `:80-87`.
- **C++** (`packages/frontend/cpp/src/extract.ts:462-471`): enums become `structure.type` with `typeKind: "enum"` and no
  members. `if` and `switch` become `flow.branch` / `flow.switch` (`:537-547`) **with no `flow.branch-arm` nodes and no
  case labels**.
- **Lens contract** (`docs/writing-a-lens.md`): the lock-order lens groups nodes by a string identity (`attrs.lock`,
  `packages/lens/lock-order/src/index.ts:50-55`) and skips scope stubs with `isExternal` (`:40`). Reuse hashes only the
  facets listed in `requires` + `optional` ("Reuse" section), so every facet the lens reads must be listed.
- **Scope**: `ctx.scope` (`packages/core/sdk/src/types.ts:134-137`). A scoped cut keeps a node only when its file is in
  the scope (`docs/scoped-ir.md:40-62`).
- **The renderer is not enough for a state diagram:**
  - `GraphCanvas.tsx:49-62` never draws edge `label`, and `confidence` is stored (`:102`) but not styled.
  - Node spans are dropped (`:93`), and an edge pick is always worded "calls"/"imports" (`:119`).
  - The layout is always `cose` (`:110`).
  - `LensPage.tsx:191-221` adds an "Import edges" table to *any* graph whose edges have spans.
  - Table cells are plain text, with no source links (`:225-251`).
- **Registration**: `apps/hosted/package.json:37-43` lists every lens as a workspace dependency. The loader finds
  `packages/lens/*` by itself (`scripts/build-vercel-hosted.mjs:76`). Each lens gets its own tab automatically
  (`Workspace.tsx` → `LensPage`). The hosted export saves root-scope lens results that have content
  (`apps/export/src/index.ts:139-147`), so nothing there needs changing.
- **Versions**: TS frontend `0.2.1` in three places (`src/index.ts:26`, `package.json:3`, `insight-plugin.json:3`);
  C++ frontend `0.1.0`.

## Decisions (made here; change them before a phase starts, not during it)

**D1. New core facet `state`.** The new kinds are emitted by core frontends, so they don't belong in an `x-*` facet.
Touches `facets.ts` (`CORE_FACETS` and `FACET_PATTERN`), `schema/facets/state.schema.json`, `core.kinds.json`, and the
generated types (`pnpm --filter @insight/ir gen`). Other lenses' reuse keys are unaffected: they don't list `state`.

**D2. What counts as a holder.** A holder is a declared field (class or interface property, or type-alias object
member), a module variable, or a function-local `let`, whose declared type is **finite**:
- an enum (including `const enum`), or a union of string or number literals, or a named alias of either;
- `| null | undefined` is allowed, and becomes the state `∅`;
- `boolean` is excluded by default (config `includeBooleans`, default `false`), because it is mostly loading flags;
- an open `string` or `number` is never a holder;
- **React `useState<T>(init)`** with a finite `T` is a holder. Its id is `<file>#<Component>/<name>`, writes are calls to
  the destructured setter, and tests read the destructured value. `T` is read from the type-argument node
  (`checker.getTypeFromTypeNode`), so it still works on hosted indexes, which have no `node_modules`. When there is no
  type argument, the domain comes from the initial literal only, and the holder is open (see D7).

**D3. Holder identity.** One `state.holder` node per declaration, following the node-id convention:
- a field: `<declFile>#<Type>.<prop>`, with parent the `structure.type`;
- a module variable: `<file>#<var>`;
- a local: `<file>#<fn qname>/<var>`.

All instances of a type share one machine. This is the same limit as lock names, and it is documented.

**D4. Writes (TS).** One `state.write` node per site, with parent the owning function (or the module entry):
- (a) assignment `r.p = V` or `p = V`, where the left side resolves to a holder symbol;
- (b) an object-literal property `p: V`, or shorthand `p` bound to a literal-typed const, whose literal's contextual
  type (through `Partial`/`Pick`/spread/apparent type) has the holder as property `p`. This covers reducers
  (`{...s, status: "done"}`), patches (`registry.update(id, { status: "indexing" })`), `setState({...})` and
  construction;
- (c) the declaration initializer, a useState initial argument, and an object literal **with no spread whose contextual
  type is exactly the declaring type** (not `Partial`/`Pick`) all get `op: "init"`. Everything else is `op: "set"`;
- (d) the value is normalised with the checker. When `getTypeAtLocation(V)` is a single literal type (or an enum
  member), `value` is that literal, as `"idle"`, `3` or `Phase.Idle`, so `const IDLE = "idle"` works. Anything else is
  `dynamic: true`, `value` absent;
- (e) **setter helpers**: a method or function whose body assigns one of its parameters straight to a holder
  (`this.state = state`, unconditionally, at most once) is a *setter* for that holder. Each call to it with a literal
  argument (`this._changeState(ActivationState.ACTIVE)`) emits a `state.write` at the call site, with `via: <setter
  id>`, the receiver of the call, and the same guard rules as a direct write. The assignment inside the setter emits
  nothing (it would be a `* → dynamic` write). This generalises the `useState` setter, and stompjs depends on it.

  `return V` from a function typed with the union, compound assignment, and writes through computed keys are not writes
  (listed in the limits below).

**D5. Tests (TS).** One `state.test` node per comparison of a holder read against literal values:
- `h === V`, `h !== V`, `V === h`, `==`, `!=`;
- `switch (h)`, one test per case group (consecutive empty fall-through cases merge into one test with several values).

Attrs:
- `holder`, `values[]`, `negated`;
- `receiver` (normalised receiver text, `""` for a plain variable);
- `arm`: the id of the `flow.branch-arm` in which `holder ∈ values` holds;
- `elseArm`: the id of the arm in which it doesn't hold.

The holder read is matched after stripping parentheses, `as` casts, `!` non-null and `satisfies`, so
`(this._connectionState as any) === X` counts (SignalR uses it). A test guards only when it is the whole condition or a
top-level `&&` conjunct, or its `!` (which swaps `arm` and `elseArm`). A comparison inside `||` or a call argument is emitted with no `arm` (counted, not used). **Early exit**:
`if (h !== V) return|throw|continue|break;` sets `exitGuard: true`, meaning "the statements after this `if` in the same
block run only when `h ∈ V`".

**D6. Guards are resolved in the frontend, not the lens.** The lens never re-parses source. Per function, the frontend
runs a small **abstract interpretation over the structured AST** (no CFG needed). For each `(holder, receiver)` it
tracks the *known set* of values, which is "unknown" (`*`) at function entry (the lens may narrow an entry `*` later
from call sites, D7):
- a guard (arm or early exit) narrows the set; a negative guard subtracts from the domain;
- **a write replaces the set** with `{value}` for the statements it dominates. This is why SignalR's `Connected` write
  after `Connecting` gives `Connecting → Connected`, not `Disconnected → Connected`;
- `if`/`else` and `switch` arms join by union;
- `return`/`throw`/`break`/`continue` end a path;
- a loop body is entered with the union of the entry set and every value written in the body (two passes, then
  widened to `*`);
- `catch` starts from the `try` entry set ∪ every value written in the `try`; `finally` starts from the union of both;
- **`await` and `yield` mark the set stale.** Another task may write the holder while this one is suspended, so a write
  whose `from` comes from a stale set is `inferred`, not exact. A re-test after the await (SignalR's `!== Reconnecting`
  rechecks) makes it fresh again;
- a call to a function or method not known to leave the holder alone does **not** reset the set (that would drown every
  machine in `*`); this is documented as a limit.

Each `state.write` then carries:
- `from: string[]`: the known set at the write, absent when it is `*`;
- `guards: <state.test ids>`;
- `guardMatch: "receiver" | "holder"`. `receiver` means the write and the guard share the receiver text: exact. `holder`
  means the write has no receiver (an object-literal patch) and the guard tests the same holder on some receiver in the
  same function: inferred;
- `event`: the nearest enclosing `case` label of a switch on a **different** discriminant (for example a reducer's
  `case "start"`), cut to 60 chars;
- `guardText`: the other conjuncts of the guarding conditions, cut to 120 chars;
- `stale: true` when `from` crossed an `await` or `yield`.

**Call-site state.** At every `this.m(…)` call (and the call through a setter, D4(e)), the frontend writes the
non-`*` known sets of the enclosing class's holders onto the `calls.call` edge as `attrs.knownState: { <holderId>:
string[] }` (plus `knownStale: <holderId>[]`). It records nothing for other receivers. This is what lets the lens say
where `_completeClose` and `_stopConnection` start from.

**D7. Transition model (lens).** For each write with a `value`:
- an edge `f → value` for each `f` in `from`;
- `* → value` when it is unguarded;
- `● → value` for `op: "init"`.

Confidence is the weaker of the write's provenance and the guard match (`holder` match = inferred).

**Cross-call inference** (when `calls` is present):
- a write in `g` with no `from` takes, as its entry set, the union of `knownState[holder]` over every **exact**
  `calls.call` edge into `g`, depth ≤ 2 (so `g`'s own unguarded callers can inherit from theirs);
- if any caller edge lacks a known state for that holder (including callbacks, references and callers outside the view),
  `*` stays in the set;
- the resulting edges are `inferred`.

So `_stopConnection`, which is called from transport `onclose` callbacks, keeps `* → Disconnected`, while
`_completeClose` gets `Disconnecting → Disconnected`. The lens reads `calls` only for this, so without it every
function-entry write is `*`.

Dynamic writes give no edge: they are counted and listed with their span. **The lens never invents a state the IR can't
name.**

A machine's states are its domain ∪ written values ∪ tested values, plus the synthetic `●` and `*` when used. A holder
is drawn as a machine only when it has ≥ 2 distinct written values, or ≥ 1 write and ≥ 1 test (P0 may move this).
Others count as `holdersSkipped`. An open holder (useState with no type argument) is drawn but labelled "domain
unknown" and gets no findings.

**D8. Findings** (project pass only, `ctx.scope` undefined or `""`, because a scope cut drops writes):
- `unentered:<holderId>|<value>` (warning): a domain value that no write or init produces, on a holder that has at
  least one write;
- `dead-test:<testId>` (info): a tested value that nothing writes or initialises.

Terminal states, unguarded writes and dynamic writes are metrics, not findings.

**D9. Lens output.**
- Views:
  - one **`state-machine` view per machine** (new view type, D10), id `machine:<holderId>`, ordered by transition
    count desc then holder id. The page shows one at a time (D10), so there is no cap;
  - table `machines`: holder, file, domain, states, transitions, exact, inferred, unguarded, dynamic;
  - table `transitions`: holder, from, to, event, guard, confidence, function, line, with row spans (D10).
- State ids are `<holderId>|<value>`, `|●` and `|*`, with `kind` `initial`, `any`, `state` or `unentered`.
  Transitions with the same from, to and label merge, keeping every site.
- A transition's `label` is the event, else the owner function's display name (`start`, `_stopInternal`). It carries
  `confidence` and its sites (span + function).
- Metrics: `holders`, `machines`, `states`, `transitions`, `exact`, `inferred`, `heuristic`, `unguardedWrites`,
  `dynamicWrites`, `holdersSkipped`, `testsWithoutArm`, `staleWrites`.
- With zero holders, metrics are all 0 and the page says "Nothing to show". An empty result must not read as a clean
  bill of health.
- Lens requires `structure`, `state`; optional `flow`, `calls`; config `{ includeBooleans?: boolean }`; manifest
  version `0.1.0`.

**D10. A dedicated state-diagram view** (cytoscape's dot graph is not a state diagram; every other lens renders
unchanged).
- **SDK** (`packages/core/sdk/src/types.ts:123`): add `StateMachineView` to the `LensView` union:

  ```ts
  { type: "state-machine"; id; title; holder: { id; name; file?; domainKind; span? };
    states: { id; label; kind: "initial" | "any" | "state" | "unentered"; span? }[];
    transitions: { id; from; to; label?; confidence: Confidence; sites: { span?; fn?: string }[] }[];
    notes?: string[] }
  ```

  Also add optional `TableView.spans?: (Span | null)[]`, one per row. Update every `resultHasContent` (web, and
  `apps/export/src/index.ts:60`) to count a state-machine view with ≥ 1 transition as content.
- **`apps/web/src/components/StateDiagram.tsx`** (new) + `apps/web/src/states/layout.ts`: SVG, laid out with
  **elkjs** (already a dependency, `apps/web/package.json:24`): `layered`, direction DOWN, orthogonal or spline routing,
  edge labels placed by ELK. Run it through the existing ELK worker if one is reusable, else inline; a machine is under
  30 nodes. Drawing rules, in app tokens, for light and dark:
  - a state is a rounded rect with its name inside, using the domain's spelling (`Connected`);
  - `●` is a filled dot. `*` is a dashed pill labelled "any state", drawn only when used;
  - an `unentered` state is greyed with a hairline dashed border;
  - a terminal state (no outgoing arcs) gets a double border;
  - a self-loop is an arc on the state's right side;
  - arcs between the same two states in both directions are drawn apart;
  - arc labels sit on a sheet-coloured pill;
  - `exact` arcs are solid, `inferred` dashed, `heuristic` dotted, with a legend.
- **Interaction:**
  - hover highlights a state's in and out arcs;
  - clicking an arc opens its first site in the source pane and lists every site in the side panel (function, line,
    guard, confidence);
  - clicking a state opens the holder declaration for the domain, or the first write that enters it;
  - keyboard: Tab through states, Enter selects;
  - zoom-to-fit with pan for wide machines.
- **`LensPage`:** when a result has state-machine views, render a **machine list** (holder · states · transitions,
  first one selected) beside a single `StateDiagram`, instead of stacking every view. Keep `machine=<holderId>` in the
  hash so links survive a reload. The tables render below as usual, with line links when `TableView.spans` is set.
- The cytoscape graph path, the "Import edges" table and every other lens's views stay as they are.

**D11. Scope.** The lens reads the scoped view:
- machines are built from in-scope writes and tests only;
- a holder declared outside the scope has no `state.holder` node there, so its domain is "declared outside this scope"
  and it gets no findings;
- **widening**: the exact transitions of a narrower scope are a subset of the wider scope's (property-tested in P4).

**D12. C++ (separate phase, heuristic):**
- enum and enum-class members → `state.holder` domain;
- a field or global whose declared type text names a project enum → holder;
- writes `x = E::M`, `x_ = M`, and member-initialiser lists (init);
- tests `==`/`!=` and `switch (x) case E::M:`.

This needs **`flow.branch-arm` emission for if/else/case in the C++ frontend**, which it lacks today (`:537-547`). All
C++ state facts are `heuristic`. It ships after TS, and nothing else depends on it except docs.

## IR contract (P1 target)

| Kind | On | Attrs (required **bold**) | Parent |
|---|---|---|---|
| `state.holder` | node | **name**, **domainKind** (`enum`/`union`/`open`), **values** (string[], normalised, `∅` for null/undefined), declaredType? | type, file or function |
| `state.write` | node | **holder** (holder id), **op** (`init`/`set`), value?, dynamic?, receiver?, from? (string[]), stale?, guards? (test ids), guardMatch?, event?, guardText?, via? (setter fn id, D4(e)) | owning function / module entry |
| `state.test` | node | **holder**, **values** (string[]), negated?, receiver?, arm?, elseArm?, exitGuard? | owning function / module entry |
| `calls.call` (existing edge, new optional attrs) | edge | knownState? (`{ [holderId]: string[] }`), knownStale? (holderId[]) | — |

All three new kinds have spans. The `calls.call` attrs are optional and only emitted when the `state` facet is on, so
other lenses and old indexes are unaffected. Lenses that hash `calls` for reuse (e.g. the calls lens) will re-run once
after the frontend bump, which is expected. `holder` is an id string, not an edge, so a scope cut never stubs it (D11). The schema rejects
`set` with neither `value` nor `dynamic`. Value encoding: strings JSON-quoted (`"idle"`), numbers bare (`3`), enum
members `Type.Member`, so `"3"` and `3` stay distinct.

## Phases

### P0: Sizing probe (read-only, about 1 h)
First, fetch the example repos into a scratch dir (not the repo): the SignalR sparse clone and
`git clone --depth 1 -b develop https://github.com/stomp-js/stompjs`. Record both commit shas in the "Example repos"
section, and hand-trace `HubConnectionState`, `ConnectionState` and `ActivationState` against D4–D7 to confirm or
correct the expected diagrams there. Any edge the rules can't produce becomes either a rule change or a listed limit.

Then a standalone script (TS compiler API, in job tmp, not committed) over this repo, `~/cognition/src`, the SignalR
`src` folder and stompjs `src` counts:
- candidate holders by domain kind (enum, union, useState), plus booleans separately;
- writes by form (assign, literal patch, init, setter) and the dynamic share;
- tests by form, and the share that guard (arm or early exit);
- writes with a same-function guard, split into receiver and holder matches;
- the top 10 holders by write count.

Record the numbers under "P0 results" here, and set the machine threshold and the `includeBooleans` default from them.
**Accept:** a table of numbers; projected state nodes under 5 % of today's node count at the root of every project;
`ProjectRecord.status` appears with ≥ 3 values; the three example machines have a confirmed expected edge list
with pinned shas.

### P1: IR kinds (depends on nothing)
Files: `packages/core/ir/src/facets.ts`, `schema/facets/state.schema.json`, `schema/core.kinds.json`, then
`pnpm --filter @insight/ir gen`, `packages/core/ir/test/ir.test.ts`, and `docs/ir-reference.md` (a facet row and three
kind rows).
**Accept:** `isFacetId("state")`; `validateIR` accepts one valid node of each kind and rejects a `set` write with no
value or `dynamic`, and a holder with no `values`; the generated types compile; IR tests are green.

### P2a: TS frontend (after P1)
Files: `packages/frontend/typescript/src/state.ts` (new: holder detection, write/test emission, guard resolution) called
from `extract.ts` next to the flow emission (`:1587-1639`), and the fixture `test/fixtures/sample-ts/states/` with:
- a class field with assignments;
- an interface field written by `update(id, { status })` patches;
- a reducer with `{...s, status}` per `case action.type`;
- an enum holder;
- a `useState<Mode>` holder;
- an early-exit guard, an `||` test, a dynamic write, a const-literal value, and a boolean field (excluded);
- `connection.ts`, a cut-down copy of the SignalR `HubConnection` shape (written fresh, not copied, ~80 lines):
  string enum, constructor init, write-after-write in one function, `try`/`catch` writes, an `await` between a write
  and the next, an `(x as any) === E.A` re-test, and a `this._complete()` helper called from inside an
  `if (=== Disconnecting)` arm and from a callback;
- `activation.ts`, the stompjs shape: numeric enum, a `_changeState(s)` setter called with literals under early exits
  and one wrapping `if`.

Regenerate goldens with `UPDATE_GOLDEN=1`, and bump TS `0.2.1 → 0.2.2` in all three places (or the next patch on
master, if the System tab plan's P3 has landed first).
**Accept:**
- the golden has the exact holders, writes and tests above, with the right `from`/`guardMatch`/`event`;
- the boolean emits nothing; the `||` test has no `arm`; the dynamic write has `dynamic: true` and no `value`;
- a local function named `useState` that isn't React's emits no holder;
- `connection.ts`: the second write in a function has `from` = the first write's value; `catch` writes have `from` =
  entry ∪ try-written values; the write after `await` has `stale: true` until the re-test clears it; the cast test is
  recognised; the `this._complete()` call edge from the `if` arm has `knownState` and the one from the callback has none;
- `activation.ts`: the setter body emits no write, each literal call emits one with `via`, and the call under
  `if (=== DEACTIVATING)` has `from: [DEACTIVATING]`;
- a full re-index of this repo gives 0 validation errors, and `apps/server/src/jobs.ts` yields writes `indexing`
  (`:192`), `idle` (`:247`) and `error` (`:252`) on holder `…#ProjectRecord.status`.

### P2b: C++ frontend (after P1; can follow later)
Implement D12 and `flow.branch-arm` for if/else/case in `packages/frontend/cpp/src/extract.ts`. Add a fixture with an
`enum class` field machine and a `switch`, regenerate goldens, and bump C++ `0.1.0 → 0.1.1`.
**Accept:** the golden has holder, writes and tests, all `heuristic`; branch arms appear for if/else/case; the
`samples/benchmark` index has 0 validation errors, with its state-node count recorded.

### P3: SDK + renderer (depends on nothing)
Files: `packages/core/sdk/src/types.ts` (`StateMachineView`, `TableView.spans`), new
`apps/web/src/components/StateDiagram.tsx` and `apps/web/src/states/layout.ts`, `apps/web/src/pages/LensPage.tsx`,
`apps/export/src/index.ts` (`resultHasContent`), `styles.css` (a new `.state-diagram` section only), and web tests.
Implement D10. Work against a hand-written `StateMachineView` fixture equal to the expected `HubConnectionState`
diagram, so P3 doesn't wait on P2a/P4.
**Accept:**
- `layout.ts` unit test: the fixture lays out with no overlapping state boxes, every edge label has a position, `●` is
  in the top layer, and the result is the same across two runs;
- the rendered SVG has one rounded rect per state, a filled start dot, a `.sm-arc--inferred` dashed arc, a self-loop
  path, and labels for every arc;
- clicking an arc calls the source-open handler with the first site's span; clicking a state does the same for its span;
- a result with two machines shows the machine list, switches diagrams on click, and restores `machine=` from the hash;
- a table with `spans` shows line links that open the source panel;
- the dependencies and calls lens views give the same DOM as before (snapshot), including the "Import edges" table;
- a dev page or Storybook-free test route renders the fixture, screenshotted in light and dark for a look check;
- web tests are green.

### P4: Lens package (after P1 + P0; fixtures are hand-built, so P2a is not needed)
Create `packages/lens/states/` (`package.json` `@insight/lens-states`, `insight-plugin.json` id `lens-states`, `src/index.ts`
with `stateMachines(view)` exported for tests, plus `test/states.test.ts`), and add it to `apps/hosted/package.json`.
Implement D7–D9 and D11.
**Accept** (hand-built `irFixtures`):
- a simple reducer, a guarded transition, a self-transition, a terminal state and two machines in one view;
- an indirect (cross-call) write whose only exact caller has `knownState` gives an inferred edge with no `*`, and one
  more caller without `knownState` brings `*` back;
- a `stale` write gives an inferred edge;
- a hand-built IR equal to P0's traced `HubConnectionState` facts produces exactly the expected edge list;
- a dynamic write giving no edge plus a metric;
- a recursion or callback path that terminates;
- the `unentered` and `dead-test` findings on the project pass, absent with `ctx.scope = "src"`;
- stable ids and output order under shuffled input;
- one `state-machine` view per machine, ordered by transition count then id, with merged transitions keeping every site;
- zero holders gives zero metrics and no views with content;
- a missing `state` facet makes the lens unavailable;
- the scope-widening subset property holds over a two-folder fixture;
- reuse: the same inputs reuse the result, and a changed `state` node re-runs it.

`pnpm -r --workspace-concurrency=1 build` passes, and the loader lists `lens-states`.

### P5: End to end and browser (after P2a + P3 + P4)
Index, on a test server (not :4317): the SignalR `src/SignalR/clients/ts/signalr` folder at the pinned sha, stompjs at
its pinned sha, `test/fixtures/sample-ts/states`, and this repo. Then open the States tab. Playwright checks:
- **SignalR**: the machine list has `HubConnection._connectionState` and `HttpConnection._connectionState`; the
  `HubConnectionState` diagram has every edge of P0's expected list with the right solid/dashed style and no edge
  outside it except listed `*` arcs;
- **stompjs**: `Client.state` shows `● → INACTIVE`, `→ ACTIVE`, `→ DEACTIVATING`, `DEACTIVATING → INACTIVE`, with the
  setter-call sites as arc sources;
- this repo: the `ProjectRecord.status` machine shows `idle`, `indexing` and `error` with the real edges;
- clicking an arc opens its write line in the source panel, and clicking a transitions-table line link does the same;
- a folder scope (`apps/server`) still draws the machine;
- the cognition root gives a non-empty machine list.

Save screenshots (SignalR HubConnection and stompjs diagrams, desktop dark + light, plus phone) to
`docs/screenshots/states-lens/`.
**Accept:** every check passes and the screenshots are committed. Look at them by eye: it reads as a state diagram
(boxes, start dot, labelled arrows), labels are readable and don't overlap, and the start dot is at the top.

### P6: Docs and gate (after P2b + P5)
- New `docs/states-lens.md`: dialect, IR contract, confidence model, guard rules, scope behaviour, config, and the
  false-positive and false-negative boundaries.
- `docs/writing-a-lens.md`: the new `state-machine` view type and `TableView.spans`.
- `docs/states-lens.md` embeds the SignalR and stompjs screenshots as the worked examples.
- `docs/ir-reference.md` is already updated in P1.

Run the full gate: `pnpm -r --workspace-concurrency=1 build`, then `pnpm -r --no-bail --workspace-concurrency=1 test`. The
only accepted failure is the known clock-dependent `apps/hosted/test/auth.test.ts` refresh test.
**Accept:** the gate is green except that test, and the docs list every limit below.

DAG: `P1 → P2a`, `P1 → P2b`, `P0 + P1 → P4`, `P2a + P3 + P4 → P5`, `P2b + P5 → P6`. P0, P1 and P3 can start in
parallel. P2a, P2b and P4 can run in parallel after P1. Each phase is one branch touching one area: IR, TS frontend,
C++ frontend, web, or lens.

**Overlap with `.claude/plans/system-tab.md`:** its P2/P3 also edit `core.kinds.json`, `docs/ir-reference.md`, the TS
frontend and its version. Land them one after the other, and take the next patch version on master at the time.

## Out of scope / known limits (document, don't build)

- Protocol or lifecycle states inferred from effects (open → read → close), and implicit states such as a nullable
  object that is either "loaded" or not.
- Open-domain holders (`status: string`), booleans by default, and states held in Maps, arrays or computed keys.
- `return V` as a write, compound assignments, and writes through aliases (`const r = this; r.state = …` is matched only
  when the checker resolves the symbol).
- A guard is recognised only within the same function, plus cross-call depth ≤ 2 over exact `this.m()` calls carrying
  `knownState`. Guards through callbacks, `||`, `.includes`, getters (stompjs `get active()`), and helpers like
  `isIdle(s)` are not followed.
- Calls to other methods don't reset the known set, so a callee that writes the holder can make a later `from` too
  narrow. `await`/`yield` only mark it stale (inferred).
- Setter helpers are recognised only when they assign a parameter straight to the holder, unconditionally.
- Declarative machines (xstate configs, transition tables as object literals) are a possible later dialect, not this
  one.
- Very large repos (all of aspnetcore) are indexed by subfolder locally; the hosted path takes the whole tarball.
- All instances of a type share one machine. A guard on `a.status` constrains `b.status` only when there is no receiver
  (an inferred `holder` match).
- `useState` with no type argument has an open domain, and gets no `unentered` findings.
- C++ is syntactic (heuristic): enum-typed fields by type-name text, and no macros or templates.
- Findings only on the project pass. Scoped views show partial machines.
