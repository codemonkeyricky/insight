# Flow: coupling focus

Status: proposal, revised 2026-11-15 with the owner's decisions. Base: master d203103.

## Goal

A function's chart in the Flow tab should show the human **the part an agent may get wrong**. An agent can hold a
whole module in context and reason about its correctness, so everything inside the function's own module is noise in
this view and drops out. What stays is what couples the function to the larger code:

- calls into other modules;
- IO (disk above all);
- global state, and module-private state that the module's surface exposes;
- concurrency;
- exceptions that escape the function.

## Decisions (2026-11-15)

1. **The boundary is the module, and module identity comes from the IR.** It is not the file. The module is the
   package the Arch model already assigns each file to (see "Module boundary" below).
2. **Calls inside the module are local, exported or not.** That includes a call to the module's own exports.
3. **Immutable module constants are dropped.** A `const` table that is never written is something the agent checks
   within the module.
4. **An escaping `throw` is highlighted.** It couples the function to every caller.

## What the chart shows today

`factsForFile` (`packages/core/flow/src/build.ts:247`) builds a function's chart from three sources:

- the `flow` facet: branch, switch, loop, try, return, throw, break, continue, blocks (`toEvent`, `build.ts:83-117`);
- the `concurrency` and `effects` facets, but only await, spawn and effects (`build.ts:273`). `sync.*` and channel
  send/recv never become rows;
- every `calls.call` edge from the function (`build.ts:277`), labelled `callee()`.

`calls.call` is emitted only when the call resolves to a function the project declares (TS `emitCall`,
`frontend/typescript/src/extract.ts:1548`; C++ `extract.ts:517`), so library calls such as `arr.map()` are already
absent. The noise is therefore:

1. calls to functions in the same module, which are most of the call rows;
2. control-flow skeleton (branches, loops, try, early returns, break/continue) that contains nothing coupled;
3. no way to see module-level state at all: no IR records a read or write of a module variable, a global or a
   `static`. `state.holder` exists, but only for enum- and literal-typed holders.

Facts already in the IR that this plan uses:

- `structure.function.attrs.exported`: TS from the `export` modifier (`extract.ts:156`); C++ `!anon && !static`
  (`cpp/src/project.ts:540`). SystemVerilog does not set it.
- Each call target's file, from the target node's `span.file`.
- The candidate list of an interface or registry call. `FlowNode.target` keeps only `nodes[0]` (`build.ts:280`), so
  classification has to read the edge, not the node.
- `effects.*`, `concurrency.*` and `sync.*` nodes, and `flow.throw` / `flow.try` with their containment.

## Module boundary

`moduleOf(file)` is the package root that `archModel` already computes. `packageRoots` and `rootOf`
(`packages/core/model/src/arch/arch.ts:189-234`) are lifted into an exported helper, so Flow and Arch always agree
on what a module is. The sources, in order:

- `structure.package` nodes from the build-system frontends (Bazel, CMake), merged per `root` as the IR reference
  describes;
- `package.json` directories (the TypeScript case, since that frontend emits no package nodes);
- a `structure.module` ancestor (SystemVerilog emits these);
- when the only root is `.` (a repo with no package metadata), the top-level directory, as `topDirLayerOf` does for
  Arch layers. Otherwise the whole repo would be one module and the view would show nothing.

A function's **module surface** is the set of functions in its module that another module calls (a `calls.call` or
`calls.reference` from outside), plus the exported functions of the package entry files. Plain `exported` alone is
not enough, because inside a package most files export to each other.

## Coupling classes

Each chart row gets one class, computed in a new pure module `packages/core/flow/src/coupling.ts`:

| Class | Rule | In the coupling view |
|---|---|---|
| `local` | call to a function in the **same module** (exported or not); read of an immutable constant; read or write of module-private state from a function not on the module surface | dropped, but its footprint is hoisted (below) |
| `cross` | call to a function in another module | kept, emphasised; badge `may throw` when the callee's footprint has `escape` |
| `io` | any `effects.*` row: fs, net, proc, env, clock, os, message | kept, coloured by kind; `fs.write` strongest |
| `state` | read or write of a global; read or write of module-private state from a module-surface function (phase 3) | kept, highlighted; a write is stronger than a read |
| `conc` | spawn, await, channel send/recv, lock, condvar, atomic | kept (coupling to another thread); channel and `sync.*` rows are new in phase 2 |
| `escape` | a `throw` not caught inside the function: no enclosing `try` with a `catch`, or a rethrow from a `catch` | kept, highlighted |
| `ctl` | branch, switch, loop, try, return, break, continue | kept only when its subtree holds a kept row |

Interface or registry dispatch (`to: {candidates}`) takes the strongest class among its candidates: cross if any
candidate is in another module.

A run of dropped rows is replaced by one thin `⋯ 4 local` row. A click expands it in place, using the same fold
mechanism as nested calls and folded loops, so the full chart is always one click away and nothing is hidden for
good.

### Hoisting through local calls

"A local variable computed by a local function can be dropped, unless that function depends on an external one."
To keep that rule, a call to a same-module function is not simply removed:

- Every function gets a **footprint**: the set of `cross`/`io`/`state`/`conc`/`escape` rows it reaches, directly or
  through same-module calls only. This is a fixpoint over the module's call graph and safe on cycles.
- An `escape` from a callee joins the caller's footprint only when the call site is not inside a `try` with a
  `catch` in the caller. A caught exception stays inside the module.
- A `local` call with an empty footprint is dropped.
- A `local` call with a footprint stays as one row, `parseConfig() ⇢ fs.read, config.load(), throws`, styled by its
  strongest class. Opening it shows the callee's own coupling chart nested, as a call step does today.

A cross-module call is not expanded into its callee's footprint. It is the boundary, and that is the point of the
view. It only borrows the `may throw` bit, and it can be opened as usual.

### Highlights

- **Hidden state behind the module surface**: a module-surface function (or a local function reachable from one)
  that reads or writes module-private mutable state. That state is a C/C++ `static` at file scope or in an anonymous
  namespace, a function-local `static`, a `static` data member, or a non-exported module-level `let`/mutable object
  in TS. Badge `◆ hidden state` on the row and on the function's canvas box. Every caller in other modules now
  shares that state.
- **Global state**: `extern`-linkage variables, `globalThis`/`window`/`self` properties, and exported mutable
  module variables written from another module. Always highlighted, at any call depth. The badge lists the other
  modules that write it.
- **Disk and IO**: `effects.fs.write` gets the strongest IO colour; fs reads, net, proc and env each have their own
  hue from the existing effect palette.
- **Escaping throws**: `escape` rows, plus a function header note `throws ↑` when the footprint has `escape`.
- Every function header gets a one-line footprint summary, also shown on canvas boxes:
  `⇄ 3 modules · fs 2 · state 1w 2r · ◆ · throws ↑`.

## Concurrency coupling (phase 2)

The execution canvas already draws process ▸ thread ▸ coroutine boxes, and the exec model already collects locks and
channels (`ExecResource`, `exec-model.ts:206`). The scene joins threads that share one with a `sync` edge
(`exec-scene.ts:434-459`). This phase makes that coupling visible in the chart and keeps it visible on the canvas.

What is missing today:

- `factsForFile` ignores `sync.*` and channel nodes (`build.ts:273`), so no chart shows a lock or a queue.
- A `sync` edge carries only `how: "lock" | "channel"`, not the resource's name. It joins the first site function in
  each thread, and roots-only keeps an edge only when both ends are kept (`keepScene`), so in the default view these
  edges mostly disappear.
- `ExecResource` covers only locks and channels. Semaphores, condvars and atomics are in the IR but not in the model.
  `sync.lock-release` is not used, so a critical section has no extent.
- A channel named `<dynamic>` cannot be paired.

### Chart rows (class `conc`)

- **Lock**: `🔒 queue_mu`. When a matching release (`sync.lock-release` with the same `lock`) follows in the same
  function, the rows between acquire and release are drawn inside a lock frame. For a C++ RAII guard with no release
  node, the frame runs to the end of the guard's enclosing block. The row's title lists the other threads that take the
  same lock ("also taken on: io thread, worker").
- **Channel**: `▶ send jobs → consumer() @ worker` and `◀ recv jobs ← producer() @ main`, with the peers from the exec
  model's resource sites. `<dynamic>` shows unpaired: `▶ send ⟨dynamic⟩`.
- **Condvar, semaphore, atomic**: `⏸ wait cv (m_)`, `↻ notify cv`, `⚛ fetch_add counter`, labelled from `op`, `name`,
  `lock` and `api`.
- **Await**: the existing row is marked as a suspension point (`⏸ await …`) whose title says other coroutines may run
  there.
- **Boundary crossings**: a `dispatches` (`message`, `start`, `callback`, `timer`, `microtask`) or a spawn names the
  thread or coroutine it lands on: `⇢ post → worker · onmessage`.
- These rows are hoisted through local calls like the other classes: `push() ⇢ lock queue_mu, send jobs`.

### Runs-on band

A chart header shows where the function runs ("runs on main · worker", from the exec model's placements), so a reader
sees the thread boundary without leaving the chart.

### Canvas

- Every `sync` edge carries the resource `name` and `kind` (lock, channel, condvar, semaphore, atomic). A lock or
  condvar is an undirected dotted line; a channel is a solid arrow from sender to receiver.
- An edge whose end is not drawn (roots-only, collapsed container) attaches to the nearest drawn ancestor, so it
  survives roots-only: the thread box, or the root function whose calls reach the site function. Several resources
  between one pair of boxes merge into one edge listing them.
- Hovering an edge lists the resource's sites (`fn`, `file:line`, op). The function panel lists the resources the
  function touches.
- `ExecResource.kind` grows to `lock | channel | condvar | semaphore | atomic`. A condvar or semaphore with a `lock`
  attribute is grouped with that lock's resource as well.

### Unguarded shared state (phase 4)

Once the `data` facet exists, a variable written from functions on two or more threads, where no common lock is held
at every write, is flagged `⚠ unguarded shared state` on its rows and on the threads' boxes. The locks held at a write
come from the lock frames above (acquire…release, or the RAII block). This lands in phase 4, together with taint.

## New IR: module-level state (phase 3)

A new core facet `data`, kept apart from `state` (which models finite holders and their values):

- Node `data.variable`, parent being its file, function or type. `attrs`:
  - `name`, `qualifiedName`;
  - `storage`: `global` | `module` | `file-static` | `function-static` | `class-static` | `extern-decl`;
  - `exported` (visible outside its file);
  - `mutable`: false for `const`/`constexpr`/`readonly` primitives and frozen literals. Immutable variables are
    dropped by the view (decision 3). They are emitted anyway, because a lens may want them.
  - optional `type`.
- Edges `data.read` and `data.write` from the function (or the file, for module-level code) to the variable, each
  with its span. `attrs.how` on a write is `assign`, `update` (`++`, `+=`), `mutate` (a mutating method on it:
  `map.set`, `vec.push_back`, a non-const member call) or `address` (address taken, or passed by non-const ref).
  Provenance is `exact` for assignments and `heuristic` for `mutate`/`address`.
- A `state.holder` that is a module variable gets a `data.variable` too, linked by the same id convention.

Emitted by:

- **TypeScript**:
  - top-level `let`/`var`;
  - a top-level `const` bound to a mutable container (`new Map()`, `[]`, `{}`, a class instance) that some function
    mutates;
  - class `static` fields;
  - `globalThis.x`, `window.x`, `self.x`;
  - imported bindings that are written (`ns.counter++`).

  Reads and writes are found with the checker's symbol for each identifier, so a shadowing local never matches.
- **C++**:
  - namespace-scope variables: `global` with external linkage, `file-static` when `static` or in an anonymous
    namespace;
  - function-local `static`;
  - `static` data members;
  - `extern` declarations, resolved to their definition.

  `const`/`constexpr` count as immutable. Writes are assignment, compound assignment, `++`/`--`, a non-const member
  call and address-of. This reuses the declaration index in `cpp/src/project.ts`, which already tracks `static` and
  anonymous namespaces.

Chart rows: `state` rows are new events in `factsForFile`, labelled `▲ counters.hits` (write) or
`▽ config` (read). Repeated reads of one variable within a straight-line run merge into one row.

## Locals that carry external values (phase 4)

"Local variable compute that depends on an external exported function should be captured": a `cross` call is
already kept. Phase 4 adds where its value goes, so control flow that depends on it is kept too:

- `calls.call.attrs.binds`: the local the call's result is assigned to (`const cfg = loadConfig()` → `cfg`),
  so the row reads `cfg ← config.loadConfig()`.
- `flow.branch.attrs.reads` and `flow.loop.attrs.reads`: the locals named in the condition.
- A within-function pass marks a local **tainted** when it binds a `cross` call, an `io` row or a `state` read, or is
  assigned from a tainted local. A branch or loop whose condition reads a tainted local is kept even if its body
  is all local, and shows the dependency (`if cfg.debug ⇠ cfg`).

This stays inside one function and only follows names, so it is cheap and predictable. It is not a full data-flow
analysis.

## View and API

- A new layer in the Flow tab's Layers panel, **Detail: Coupling | All**. It joins frames, calls, findings,
  lambdas, motion and runtime in `LayerState` (`apps/web/src/components/sheet/LayersPanel.tsx:4`, held in
  `FlowView.tsx:55`) and is saved to localStorage as `insight.flow.detail`, like `insight.flow.lambdas`
  (`zoom/lambdaPref.ts`). Coupling becomes the default once phase 1 is reviewed. Today no layer removes row kinds
  from a chart, so this is the first.
- `FunctionFlow` gains `coupling?: { module, footprint, classes: Record<nodeId, Class> }`. The coupling chart is laid
  out from the kept `items` with the existing `relayout` path. Canvas layout does not change, because function boxes
  are compact and expansions sit outside the layout (`docs/zoom-map.md`).
- The existing `↗` outside-scope mark (`FlowChart.tsx:267`, `flowTargets.ts`) stays. `cross` is about module
  boundaries, not the open scope, so the two can both show on one row.
- Canvas-box footprint chips reuse the findings-layer drawing (`zoom/findingsLayer.ts`, which counts
  `finding.nodes` per function), so a function box gets a coupling chip the same way it gets a findings badge.
- `ExecFunctionPanel` lists the footprint grouped by class, with links to each target.
- For agents: `insight coupling <fn|file|scope>` in the CLI and `GET /api/projects/:id/coupling?scope=` return the same
  footprint as JSON, so an agent can ask "what does this touch outside its module" without reading the chart.

## Phases

1. **View-only, no IR change.** In order:
   - `moduleOf` and the module surface, lifted from the Arch model;
   - `coupling.ts`: classify (`local`, `cross`, `io`, `conc`, `escape`, `ctl`), the footprint fixpoint with try/catch
     scoping for escapes, prune and hoist on `Item[]`;
   - the `⋯ n local` fold row and the Detail layer;
   - the footprint summary in the panel and on canvas boxes.

   This alone removes the same-module call rows and the empty skeleton, and it highlights escaping throws.
2. **Concurrency coupling**: lock/channel/condvar/semaphore/atomic rows and lock frames, the runs-on band, named
   `sync` edges that survive roots-only, the wider `ExecResource`.
3. **`data` facet**: schema, kinds, TS and C++ extraction, `state` rows, the hidden-state and global badges.
4. **Bindings, condition reads and unguarded shared state**: `binds`/`reads` attrs, the taint pass, kept dependent
   branches, the lock-set check over `data.write` sites.
5. **CLI/API footprint** and docs (`docs/zoom-map.md`, `docs/ir-reference.md`).

Each phase is one draft PR, stacked: `build/coupling-1` on master, `build/coupling-2` on `build/coupling-1`, and so
on. The worktrees are `.claude/worktrees/coupling-N`. The phase 3 IR extraction (schema plus the TS and C++
frontends) touches no view code, so it is built in parallel on `build/coupling-data-ir` and merged into
`build/coupling-3`. Each PR gets an Opus review before it leaves draft.

## Tests and acceptance

- **No coupling lost (property test)**: for every function in `samples/benchmark` and the insight self-index, every
  `cross`, `io`, `state`, `conc` and `escape` row of the All chart appears in the coupling chart, either as its own row
  or in a hoisted footprint. Every dropped row is reachable through a `⋯ local` fold.
- **Module agreement**: for every file, `moduleOf` equals the package `archModel` assigns it.
- **Reduction** on the same two indexes: report the median and p90 row count, All versus Coupling. Target: median at
  most 50% of All. The number decides whether coupling becomes the default.
- **Fixtures** (TS and C++ unless noted):
  - a local → local → `fs.writeFile` chain inside one module, hoisted onto the first call;
  - a local chain with nothing outside the module, dropped;
  - a call to the module's own exported function from another file of the module, dropped (decision 2);
  - a call across two packages, kept as `cross`;
  - a branch whose body is local only, dropped;
  - a branch on a tainted local, kept (phase 4);
  - an uncaught `throw` (escape); a `throw` inside `try/catch` (dropped); a rethrow from `catch` (escape);
  - a local helper that throws, called outside a try (hoisted `throws`) and inside one (not hoisted);
  - a cross-module callee that may throw (`may throw` badge);
  - a module-surface function bumping a file-`static` counter (`◆`), and an internal function doing the same
    (dropped);
  - a function-local `static` cache;
  - an `extern` global written from two modules;
  - a TS module `let`, a mutated top-level `const new Map()`, and a never-written `const` table (dropped);
  - interface dispatch with candidates in two modules;
  - a recursive same-module pair;
  - a repo with no package metadata (top-level-folder fallback).
- **Concurrency fixtures** (phase 2):
  - a TS `BroadcastChannel` send/recv pair across a worker;
  - a C++ producer/consumer queue under a mutex with a condvar;
  - an RAII `lock_guard` frame ending at its block;
  - a lock taken through a local helper (hoisted);
  - a `<dynamic>` channel (unpaired);
  - a roots-only scene whose site functions are not roots, where the named edge still joins the two roots.
- **Unguarded shared state** (phase 4): a global written on two threads with and without a common lock.
- **Component tests**: the Detail layer and its saved preference, opening and folding `⋯ n local`, keyboard access,
  and source-panel selection of a hoisted row.

## Open points

- **Module surface**: "called from another module, or exported from a package entry file". Package entries come from
  `package.json` `exports`/`main` (TS) and public build targets with `visibility` (Bazel). Check this on the benchmark
  before phase 3 relies on it.
- **TS `throw` coverage**: the TS frontend emits `flow.throw` for statements. Promise rejections and `await` of a
  rejecting call are not modelled. Phase 1 covers `throw` only, and says so in the legend.
