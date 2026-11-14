# System tab: runtime containers and OS resources

Status: **ready for implementation** (reviewed 2026-11-14 against master `cd16c41`; none of the System files changed since
`1471574`). Each phase is one branch and one draft PR. Phases run in the DAG order at the end.

## Goal

A top-level **System** tab that *illustrates* the running system for the explorer scope. Nothing is hidden behind a
toggle:

- **Runtime containers**, nested: processes (programs) contain threads; coroutines sit inside a thread, or directly
  inside a process when it has only its main thread.
- **Code components** sit inside the container they run on.
- **In-process resources** are drawn inside their process: queues (message inboxes, channels, event-loop timer/microtask
  queues), locks, semaphores, condition variables and the environment.
- **The kernel** is drawn as a boundary band. Disk, network and child processes lie beyond it, and every edge that
  leaves a process crosses the band, named by its syscall where we know it. Kernel-only operations (signals, mmap,
  ioctl, raw `syscall()`) end on the band.

Every box and edge answers three questions: *which code caused this, where, and how sure are we?*

## Where we start (facts, with file:line)

- **The view.** System is one mode of the Arch tab (`apps/web/src/components/views/ArchTab.tsx:39`, modes in
  `apps/web/src/arch/mode.ts:3`, choice kept in localStorage only and not in the URL). The model is
  `systemModel` (`packages/core/model/src/system.ts:100`), computed **client-side** by `systemFor`
  (`apps/web/src/model/payloads.ts:116`) for the live, static and hosted builds. There is no server route, so there is no
  server/hosted parity work. The layout is `layoutSystem` (`apps/web/src/arch/system-layout.ts:163`), which uses columns
  by stage, an externals column and lanes. The Pipeline mode reuses `SystemDiagram`/`layoutSystem`, so changes must keep
  Pipeline working.
- **The model today is flat.** Components are packages, folders or files (`componentOf`, system.ts:431). Externals are
  `service|store|api|process|filesystem|config|worker`. Verbs are `calls|reads|writes|runs|requests|spawns|posts`
  (+ Pipeline's `produces|feeds`). The model does not read `effects.net.listen`, `effects.clock.read`, any `sync.*` fact
  or the exec model.
- **Runtime is already modelled, but only for Flow.** `execModel(nodes, edges, scope, opts)`
  (`packages/core/flow/src/exec-model.ts:413`) returns `programs` (bin/script/browser entries, `ExecProgram` :168),
  `threads` (`ExecThread` :110: kind main|thread|process|async, `grounded`, `spawn`, `roots`, `reach`, `reached`,
  `coroutines`), `dispatches`, `resources` (locks/channels, :205) and `unthreaded`. Threads are computed project-wide and
  then filtered to the scope. `reached` is capped by `maxFunctions` (default `MAX_EXEC_FUNCTIONS = 2000`, :21) and
  `truncated` is set when the cap is hit. `@insight/model` already depends on `@insight/flow` (system.ts:4).
- **IR coverage** (kinds in `packages/core/ir/schema/core.kinds.json`, attrs in `facets/*.schema.json`):

| Concept | Kinds | Emitted by | Gap |
|---|---|---|---|
| Program | none. TS `structure.function` attrs `programEntry/nodeEntry/htmlEntry`; Bazel/CMake `packaging.build-target` | TS, Bazel, CMake | C++ `main` is a name match; the attrs are not in the schema |
| Child process | `concurrency.spawn-process`, `concurrency.spawns` how=process, `effects.proc.exec` | TS (all three); C++ `effects.proc.exec` only | C++ has no `spawn-process` and no `fork` |
| Thread | `concurrency.spawn-thread`, `spawns` how=thread | TS (Worker, worker_threads, SharedWorker); C++ (std::thread, jthread, pthread_create, std::async) | `attrs.api` is not in the schema |
| Coroutine | `concurrency.coroutine`, `async-task`, `await`, `dispatches` how=await/start | TS, C++ | C++ emits no `async-task` |
| Message boundary | `effects.message.post`, `dispatches` how=message, `calls.reference` how=handler | TS only | no receive-side node; `channel-send/recv` declared, never emitted |
| Disk | `effects.fs.read/write` (`api`, `path`) | TS catalog `packages/frontend/typescript/data/effects.json`; C++ `packages/frontend/cpp/data/effects.json` | no streams, fd-level `open/read/write/close`, `fstream`; C++ never sets `path` |
| Network | `effects.net.connect` (+ attr `confidence`), `net.listen` (`port`), `net.serve` | TS, C++ (connect/bind/listen) | `net.listen` unused by System; `http.createServer` not in catalog |
| Env | `effects.env.read` | TS `process.env.X`; C++ getenv | `import.meta.env`, `process.argv` not emitted |
| Kernel / OS | **none** | — | no kind for signals, process control, mmap, ioctl, raw `syscall()`, OS info; `effects.unknown` declared, never emitted |
| Locks | `sync.*`, `x-cpp.scoped-lock` | C++ only (inferred) | rwlock/semaphore/atomic/condvar never emitted; TS none |

- **Versions/caches.** TS frontend `0.2.1` (`packages/frontend/typescript/src/index.ts:26` **and**
  `insight-plugin.json:3`), C++ `0.1.0` (`packages/frontend/cpp/src/index.ts:27` + manifest). The shard key includes the
  frontend version (`packages/core/indexer/src/pipeline.ts:227`), so a bump re-extracts. Goldens are
  `packages/frontend/{typescript,cpp}/test/golden/sample-*.ndjson`, regenerated with `UPDATE_GOLDEN=1`. Schema changes need
  `pnpm --filter @insight/ir gen`.

## Decisions (made; change them here before a phase starts, not during it)

**D1. Placement: System becomes a top-level tab and leaves Arch.**
Tabs become Overview, Flow, **System**, Arch, then Compare, Triage and the lenses. The Arch toggle keeps **Pipeline | Packages**,
with Packages as the default. The route is `#/projects/:id/view/system?scope=…`. `system` is added to `BUILTIN_TABS`
(`apps/web/src/router.ts:7`), `layerLinks` (`components/sheet/shell.ts:42`) and FindPalette. Compatibility: a saved Arch
mode `"system"` in localStorage is read as `packages`. `view/arch` never meant System by URL, so no redirect is needed. The
Code-pane auto-collapse (`onSystemActive`) moves to the System tab and stays on for Pipeline.
*Alternative considered:* a lens tab (`view/lens-system`). Rejected because lenses are index-time plugins that produce
findings, while System is a client-side view of the project model with no lens manifest, cache or findings.

**D2. "Kernel access" is the narrow, evidence-based meaning.**
- A new base kind **`effects.os.call`** (facet `effects`, node) covers OS operations that are not already a resource
  kind. It is matched only from catalog entries naming an exact API, never from function-name heuristics. Attrs:
  `api` (required, e.g. `process.kill`, `mmap`), `op` (enum `signal|process-control|memory|device|raw-syscall|info|fd`),
  `syscall` (optional, the kernel call it maps to 1:1, e.g. `kill`), `target` (optional literal: signal name, fd or path;
  `<dynamic>` when not literal).
- A new optional **`syscall`** attr on every `effects.*` kind is set when the catalog API is a thin 1:1 wrapper of a
  syscall (C `unlink`, `open`, `connect`, `execve`; Node `fs.unlinkSync` → `unlink`). It is not set for high-level APIs
  (`fs.readFile`, `fetch`).
- Display levels, derived and not stored: **syscall** (`syscall` attr set, or `op: raw-syscall`), **API** (a catalogued
  high-level call) and **unknown** (`<dynamic>` target or command). `effects.unknown` stays un-emitted. Emitting it for
  every unrecognised external call is out of scope (noise; it needs its own plan).

**D3. Runtime comes from `execModel`, not a second derivation.**
`systemModel` calls `execModel(model.doc.nodes, model.doc.edges, scope, { maxFunctions: Infinity })` (or a cheaper
`threadsOf` export added to exec-model.ts if P0 shows Infinity is too slow) and joins on function ids. Grounding rules
stay those of Flow: a thread frame exists only for `grounded` threads (program target, real `main`, resolved spawn).
Functions in no grounded thread go to a **"Not on a thread"** frame (reuse `UNTHREADED_LABEL`,
`packages/core/flow/src/runtime-boxes.ts:14`).

**D4. Unit inside a frame = a component *slice* (component × thread).**
A component reached by two threads appears in both thread rows, each slice counting only the functions that thread
reaches. An effect fact is attributed to every slice whose thread reaches the fact's owner function (`fnOf`,
system.ts:146); module-level facts go to the thread whose files include that module. Slices are **not** dotted by
confidence. The panel states the placement: "root of this thread" or "reached by calls from `<root>`", and that
placement is inferred from calls (per the risk note).

**D5. Layout: nested frames, left to right as process | kernel | outside world. No toggles.**

```
┌ insight-server · Node ───────────────────────────────┐ ║K║
│ ┌ Main thread ───────────────────────┐  ┌ in-proc ┐  │ ║E║  ┌ Filesystem ┐
│ │ [server] → [indexer]               │  │ ▤ inbox │  │ ║R║─▶│            │
│ │   ┌ coroutine: runIndex ┐          │  │ 🔒 lock │  │ ║N║  └────────────┘
│ │   │ [indexer] [model]   │──────────┼─▶│ $ env   │  │ ║E║  ┌ Network ───┐
│ │   └─────────────────────┘          │  └─────────┘  │ ║L║─▶│ GitHub API │
│ └────────────────────────────────────┘                │ ║ ║  └────────────┘
│ ┌ Worker · slice.worker ┐  ← post ▤ inbox             │ ║ ║  ┌ Processes ─┐
│ └───────────────────────┘                              │ ║ ║─▶│ git        │
└───────────────────────────────────────────────────────┘ ║ ║  └────────────┘
```

- **Process frames** stack vertically. Each holds its **thread frames** (rows) and, at its right edge, an **in-process
  strip** with that process's queues, locks and env.
  - A process with only its main thread draws no thread frame: its coroutines and slices sit directly in the process
    frame ("inside processes or threads").
  - A child process with a resolved target is its own process frame, and the spawn edge goes from the spawning slice to
    that frame's header. With an unresolved target it is a box beyond the kernel (`git`, `tar`, "fork").
- **Coroutine frames** nest inside their thread (or process) and are always drawn. Granularity: one frame per
  concurrently running task, i.e. an `ExecCoroutine` with how=`start` (fire-and-forget async, `std::async`-style), a
  generator or a C++ coroutine. Awaited-only async functions run inline in their caller's sequence, so they stay in the
  caller's slice and carry an `await` glyph; they get frames only if P0 shows at most `COROUTINE_LIMIT` (default 16) per
  thread.
- **Inside a thread or coroutine frame**, slices are laid out in columns by stage, using the existing column, lane and
  pill code of `system-layout.ts`, applied per frame.
- **The kernel band** is a full-height vertical band between the processes and the outside world.
  - An edge from a slice to disk, network or a child process crosses it, with a chip on the band: the syscall name when
    the evidence has one (`unlink`, `connect`, `execve`), else the API (`fs.readFile`, `fetch`). Edges with the same
    chip share it (`×N`).
  - Kernel-only ops (`effects.os.call` signal, memory, device, raw-syscall, info) end on boxes inside the band, such as
    "Signals: SIGTERM, SIGINT" and "mmap ×3".
- **The outside world** is the rightmost column: Filesystem, Network (catalog services, dynamic URLs, `Listens :port`
  boxes), and external processes. HTTP routes stay as chips on the serving slice; relative requests that match a route
  go slice → slice, crossing no kernel band.
- **Density, without hiding:** frames always render. A frame with more than `SLICE_LIMIT` (default 12, set from P0)
  slices shows the first 12 and a "+N more" chip; the chip widens the frame, it does not toggle a mode. Clicking a frame
  header selects it (panel); Enter/double-click collapses or expands it, for reading only, and the default is expanded.
  "Not on a thread" is a frame inside its program, or at the bottom when no program owns it, and is expanded like any
  other.

**D6. Degradation.**
- If the model has no runtime context (`hasRuntimeContext` false, `runtime-boxes.ts:32`, e.g. a library scope, a C++
  project with no `main` or an old snapshot), there are no process or thread frames. Components are laid out as today,
  but the kernel band and the D7 resource placement still apply. In-process resources then sit in one strip labelled
  "In process (no entry found)". The toolbar says "No runtime entry in this scope".
- If the exec model is truncated (only possible if D3 keeps a cap), the view falls back to flat with "Runtime skipped:
  N functions".
- Snapshots older than P3 have no `effects.os.call`, so they simply show no Kernel box. The model is rebuilt from the IR,
  so there is no serialized-shape migration. The hosted featured index needs a re-index after deploy.

**D7. Resource placement, categories and verbs.**
- **In-process resources** (owned by a process frame):
  - `queue`: message inbox, channel or event-loop queue;
  - `lock`: mutex, rwlock or `navigator.locks`;
  - `semaphore`, `condvar`, and `env`, which moves here from the old Config external because the environment is part of
    the process.
- **Kernel ops** (`effects.os.call`), on the band.
- **Outside**: `filesystem`, `service`, `store`, `api`, `process`, and `listen` for `net.listen`.
- **New verbs:** `enqueues` / `dequeues` (queue send / recv, message post / handler), `locks` (acquire; the release is
  folded into the same edge), `waits` / `notifies` (condvar, semaphore), `listens`, `signals` (signal, process-control)
  and `maps` (memory, device). Other os ops use `calls`.
- Clock reads stay hidden. Atomics are counted on the lock's or slice's panel, not drawn, because they are too dense to
  draw.

**D8. Queues and locks are first-class: frontends must emit them (they are mostly missing today).**
A queue or lock resource is one named object, keyed by `attrs.channel` / `attrs.lock` (already how `execModel` groups
`ExecResource`, exec-model.ts:355-362). Sources:
- **Message inboxes (TS, from existing facts):** each Worker and the page has one inbox. `effects.message.post` →
  `enqueues` to the receiver's inbox; the `onmessage`/`addEventListener("message")` handler (`dispatches`
  how=message) → `dequeues`. The inbox is derived in the model and needs no new IR. An unresolved receiver gives an
  "inbox (unknown peer)" box.
- **Event-loop queues (TS, from existing facts):** `dispatches` how=timer / microtask / callback give the thread's
  "Timers", "Microtasks" and "Callbacks" queue boxes in the in-process strip, with an edge from the scheduling slice.
- **Explicit channels and queues (new emission, `concurrency.channel-send/recv`, kinds already declared):**
  - TS: `new MessageChannel()` port1/port2 `postMessage`/`onmessage`; `new BroadcastChannel(name)` (channel =
    literal name).
  - C++ catalog: `boost::lockfree::queue` / `spsc_queue` push/pop, `moodycamel::ConcurrentQueue`
    enqueue/try_dequeue, `folly::MPMCQueue` write/read, `tbb::concurrent_queue` push/try_pop.
  - The channel name is the receiver expression (`this->jobs` → `Class::jobs`); otherwise `<dynamic>`.
  - Not matched by name: a plain `std::queue` is a queue only when an inferred rule holds (below).
- **Inferred guarded queue (C++, confidence `inferred`):** a `std::queue`/`std::deque` member that is push/emplace'd
  and pop/front'd in functions that hold the same lock is emitted as channel-send/recv with
  `channel = Class::member` and `attrs.guardedBy = <lock>`.
- **Locks and sync (new emission for kinds already declared):**
  - C++: `std::shared_mutex` + `shared_lock` → `sync.rwlock-acquire`; `std::counting_semaphore` / `binary_semaphore`
    acquire/release and `sem_wait` / `sem_post` → `sync.semaphore` (attr `op`); `std::condition_variable`
    wait/notify_* and `pthread_cond_*` → `sync.condvar` (attr `op`, `lock`); `std::atomic` member ops →
    `sync.atomic-op` (counted, not drawn).
  - TS: `navigator.locks.request(name)` → `sync.lock-acquire` (lock = literal name); `Atomics.wait/notify` →
    `sync.condvar`, and other `Atomics.*` → `sync.atomic-op`.
- **Channel/lock identity across files** is by name string only. Two different objects with the same qualified member
  name merge, which is a documented limit.

## Model shape (P4 target)

```ts
interface SystemModel {            // existing fields unchanged
  runtime: "grounded" | "none" | "truncated";
  runtimes?: SystemRuntime[];      // present when runtime === "grounded"
  slices?: SystemSlice[];
  // edges' from/to may now be slice ids ("<runtime>|<component>") or runtime ids, plus component/external ids as today
}
interface SystemRuntime {
  id: string;                      // reuse execProgramId / execThreadId / execCoroutineId (exec-scene.ts:44-66)
  kind: "program" | "thread" | "coroutine" | "unthreaded";
  implicit?: true;                 // the main thread of a single-thread process: not drawn, its children render in the process frame
  resources?: string[];            // in-process resource ids (queues, locks, env) owned by this program
  label: string;                   // program name ("insight-server · Node"), "Main thread", "Worker · slice.worker", "Not on a thread"
  parent?: string;
  programKind?: "node" | "browser" | "native";
  spawn?: Site & { api?: string; status: "resolved" | "outside" | "unresolved" };
  coroutines?: number;
}
interface SystemSlice { id: string; runtime: string; component: string; functions: number; root: boolean; awaits?: number }
interface SystemResource {         // in-process resources and kernel ops
  id: string;                      // "queue:<program>:<channel>", "lock:<program>:<name>", "env:<program>", "os:<op>"
  kind: "queue" | "lock" | "semaphore" | "condvar" | "env" | "os";
  label: string;                   // "Worker inbox · slice.worker", "Timers", "Class::jobs", "mutex m_", "Signals"
  program?: string;                // owner process frame (absent for os)
  source: "message" | "event-loop" | "channel" | "inferred-queue" | "sync" | "env" | "os";
  names?: string[];                // env var names, signal names, op names
  atomics?: number;
}
// SystemModel gains: resources?: SystemResource[]
interface SystemExternal { /* + */ ops?: Array<{ api: string; syscall?: string; level: "syscall" | "api" | "unknown"; count: number }> }
interface SystemEdge     { /* + */ evidence: Array<{ api: string; syscall?: string; level: "syscall" | "api" | "unknown"; count: number }> }
```

IDs must be stable across runs (sorted inputs, no counters). `SITE_CAP = 20` is unchanged.

## Phases

### P0: Sizing probe (read-only, about 1 h)
Write a script that builds the project model and runs `execModel(…, { maxFunctions: Infinity })` at scopes `""`,
`packages`, `apps/web/src` for this repo, and `""`, `src` for `~/cognition`. Record wall time, program/thread/coroutine
counts, slices per thread, and the largest thread row. Also record:
- coroutines per thread, split into how=`start` / generators and awaited-only;
- `dispatches` per how (timer, microtask, callback, message);
- `effects.message.post` sites;
- existing `sync.*` nodes, for benchmark (C++).

Put the numbers in this file under "P0 results" and set `SLICE_LIMIT`, `COROUTINE_LIMIT` and the D3 cap choice from them.
**Accept:** a table of numbers; exec time at root under 300 ms, or else a decision to add `threadsOf`.

### P1: Top-level tab (web only)
Files: `router.ts`, `components/sheet/shell.ts`, `FindPalette.tsx`, `ArchTab.tsx`, `arch/mode.ts`, `Workspace.tsx`
(the tab switch and `onSystemActive`), docs `system-view.md`, plus any navigation doc that lists tabs.
**Accept:** `view/system` renders today's SystemView; the Arch toggle shows Pipeline | Packages only; a stored
`"system"` mode is read as packages; the tab strip order is Overview, Flow, System, Arch…; router and shell unit tests
cover the new tab and old-mode migration; existing web tests stay green.

### P2: IR kinds (depends on nothing)
Files: `core.kinds.json`, `facets/effects.schema.json` (`effects.os.call` attrs and the optional `syscall` on the effects
base), the `api` attr on `concurrency.spawn-thread/spawn-process` and `channel` (required), `api` and `guardedBy` on
`concurrency.channel-send/recv` in `facets/concurrency.schema.json`, and `op` (enum `acquire|release|wait|notify|op`),
`lock` and `api` on `sync.semaphore/condvar/atomic-op` in `facets/sync.schema.json`, then run
`pnpm --filter @insight/ir gen`, `packages/core/ir/test/ir.test.ts`, `docs/ir-reference.md` (add `effects.os.call`, and
the missing rows `effects.net.serve`, `effects.message.post`).
**Accept:** `validateIR` accepts a valid os.call node and rejects a bad `op`; the generated types compile; IR tests are green.

### P3: Frontends (after P2)
- **TS** (`packages/frontend/typescript/data/effects.json`, plus `src/effects.ts` only if a matcher must change): `process.kill`
  (os signal, syscall kill), `process.on/once("SIG*")` (os signal, target = signal name), `process.exit/abort` (os
  process-control), `os.cpus/networkInterfaces/userInfo/…` (os info), `fs.open/openSync/read/write/close/fstat` (fs or
  os fd, with syscall), `fs.createReadStream/createWriteStream` (fs read/write), `http(s).createServer` (net.listen),
  and `syscall` on 1:1 wrappers (`unlink*`, `rename*`, `mkdir*`, `stat*`).
- **C++** (`data/effects.json`, `src/extract.ts:315`): `fork`/`vfork` → `concurrency.spawn-process` (no target, so status
  unresolved) plus `effects.os.call` process-control; `kill/raise/signal/sigaction` (os signal); `mmap/munmap/mprotect`
  (os memory); `ioctl` (os device); `syscall` (os raw-syscall); `open/read/write/close/pipe/dup` (fs or os fd, with
  syscall); `std::ifstream/ofstream/fstream` construction (fs read/write); `path` from a string-literal first argument;
  `syscall` attr on the POSIX entries that already exist (`unlink`, `rename`, `connect`, `bind`, `listen`, `execve`).
- **Queues and sync (D8):**
  - TS: MessageChannel / BroadcastChannel → `channel-send/recv`; `navigator.locks.request` → `sync.lock-acquire`;
    `Atomics.*` → `sync.condvar` / `atomic-op`.
  - C++: the lock-free queue catalog → `channel-send/recv`; the inferred guarded `std::queue`/`deque` rule;
    `shared_lock` → rwlock; semaphores, condvars and atomics. The existing lock code is at `src/extract.ts:337`
    (lock/unlock) and `:408` (RAII guards); extend it there, and keep the RAII release pairing.
- Add fixture files to `test/fixtures/sample-ts` and `sample-cpp` (one site per new entry, one dynamic target each),
  regenerate goldens with `UPDATE_GOLDEN=1`, and bump TS to `0.2.2` (both places) and C++ to `0.1.1`.
**Accept:** every new catalog entry appears in a golden with the right kind/op/syscall; dynamic targets are `<dynamic>`;
no name-only matches (a local function named `kill` emits nothing, with a test). A `std::queue` with no shared lock emits
nothing; with one, it emits inferred channel facts. `execModel` `resources` on the C++ golden lists the new queues and
locks. A full re-index of this repo gives 0 validation errors.

### P4: Runtime-aware SystemModel (after P2; P3 is not needed, because fixtures are hand-built)
Files: `packages/core/model/src/system.ts` (maybe split into `system-runtime.ts`), `index.ts` exports,
`packages/core/model/test/system-runtime.test.ts`. Implement D3–D7 and the model shape above. Pipeline must keep compiling
(`pipeline.ts` builds a `SystemModel` and should set `runtime: "none"`).
**Accept** (fixture tests): one fixture with:
- a main Node program, a child process (resolved and `git`), and a single-thread program, which must get an implicit
  main thread;
- a worker thread with a message post both ways (two inboxes);
- a started (not awaited) async task and an awaited chain;
- a `setTimeout`;
- fs read + write, a fetch, a `listen`, and an env read (it must land in the process's resources);
- an `effects.os.call` signal with syscall, and a dynamic one.

Plus a C++ fixture with two `std::thread`s sharing a mutex, a guarded queue (enqueue on one thread, dequeue on the
other), a condvar and a semaphore. Check that:
- runtimes/slices/edges match a snapshot;
- IDs are stable across two builds and shuffled input order;
- a component on 2 threads gives 2 slices with the right counts;
- module-level facts land on the right thread;
- edge `evidence` levels are correct;
- the started task is a coroutine runtime under its thread, and the awaited-only function is an `awaits` count on its
  slice;
- the queue and lock resources sit under the right program, with enqueues/dequeues/locks/waits edges from the right
  slices;
- the Timers queue exists on the main thread's program;
- the no-concurrency fixture is byte-identical to today's flat model, apart from `runtime: "none"`;
- scope narrowing drops out-of-scope slices;
- `SITE_CAP` holds;
- the existing `system.test.ts` is unchanged and green.

### P5: Swim-lane layout and view (after P1 + P4)
Files: `apps/web/src/arch/system-layout.ts`, `SystemView.tsx`, `styles.css` (System section only), `apps/web/test/systemLayout.test.tsx`.
Implement D5 and D7: nested process > thread > coroutine frames (with the implicit-main-thread rule), the in-process strip
per process, the kernel band with syscall/API chips and kernel-op boxes, and the outside column.
- Resource glyphs: queue ▤, lock 🔒 (an SVG icon, not an emoji), semaphore, condvar, env $.
- The legend gains level marks: syscall = solid square tag, API = plain, unknown = hollow/dotted.
- The panel shows, for a frame: its spawn site (link), API and status, root functions (Flow links) and coroutines.
  For a slice: its placement basis and awaited functions. For a queue or lock: producers/consumers (or acquirers) by
  thread, with sites, and the atomic count. For an edge: an evidence table (api · syscall · level · count) above
  `SiteLinks`.
- Pan/zoom, Fit, Expand and Show tests are unchanged.
**Accept:**
- Layout tests:
  - no pill overlaps a card or pill;
  - no edge passes through a non-endpoint card **or a frame header**;
  - frames nest strictly (a child rect lies inside its parent, siblings don't overlap);
  - every edge to an outside resource crosses the kernel band exactly once, and in-process edges never cross it;
  - collapsed frames re-attach their slices' edges to the frame header.
- Keyboard test: Tab reaches frame headers and Enter toggles them.
- Pipeline layout tests are unchanged and green.
- Browser screenshots (desktop dark + light, phone) at this repo's root and `apps/hosted`, and at cognition `src`, in
  `docs/screenshots/system-tab/`, plus `samples/benchmark` (C++ threads and locks) and the P4 fixtures rendered through a
  test page. Check by eye that process > thread > coroutine nesting, queues/locks in the strip, the kernel band with
  chips, and disk/network beyond it are all visible with no toggle.

### P6: Docs and gate (after P3 + P5)
Rewrite `docs/system-view.md` (tab, frames, slices, levels, degradation, limits) and update the fact-rule table and
`docs/ir-reference.md`. Run the full gate with `pnpm -r --workspace-concurrency=1 build`, then
`pnpm -r --no-bail --workspace-concurrency=1 test`. The only accepted failure is the known clock-dependent
`apps/hosted/test/auth.test.ts` refresh test. **Accept:** gate green except that test; docs list every known limit below.

P3 is split by frontend so that each branch touches one package: **P3a TS** (`packages/frontend/typescript`) and **P3b
C++** (`packages/frontend/cpp`). They share only the P2 schema.

DAG: `P0 → P4`, `P2 → P3a`, `P2 → P3b`, `P2 → P4`, `P1 + P4 → P5`, `P3a + P3b + P5 → P6`. P0, P1 and P2 can start in
parallel; P3a, P3b and P4 can run in parallel after P2.

## Out of scope / known limits (document, don't build)

- Emitting `effects.unknown` and C++ `async-task`.
- Queues that are not catalogued or lock-guarded (for example an array used as a queue in TS, Node streams, EventEmitter
  events, or job-queue libraries like BullMQ) are not drawn. Add catalog rows later.
- Queue and lock identity is by name string, so same-named members of different instances merge.
- Join bars, message ordering and per-call-site boxes (the graph stays aggregated).
- Placement is call-reachability, so a callback passed into a library and run on another thread is not followed.
- Cross-package calls in hosted indexes now resolve through workspace specifiers (#53), but a bare npm import still ends at
  the package boundary.
- C++ `fork()` children have no resolved target: the child is drawn as a "fork" process frame with no rows.
- Native C++ programs are framed only via build targets plus `main` (`exec-model.ts:630`). A `main` with no build target is
  still a name match and is labelled inferred.
