# IR reference

The IR is the only thing frontends and lenses share. It is JSON, described by JSON Schema, and stored as NDJSON: one record per line. Each record is one of:

- `{"node": IRNode}`
- `{"edge": IREdge}`
- `{"finding": IRFinding}`

The schemas live in `packages/core/ir/schema/`. `core.schema.json` holds the record shapes, `facets/<facet>.schema.json` holds the attribute schemas for each facet's base kinds, `core.kinds.json` declares the base kinds, and `kind-definition.schema.json` is the format for kinds declared by plugins.

## Records

**Node.** `id` (stable string), `facet`, `kind`, `attrs` (object), `provenance`, and optionally `parent` (containment: package > module > file > function > block) and `span`.

**Edge.** `from` (node id), `to`, `facet`, `kind`, `provenance`, and optionally `attrs` and `span`. `to` is one of:

- a node id string, for an exact target;
- `{"unresolved": {"scheme": "cpp.include", "text": "net/socket.h"}}`, for a reference a resolver must settle later;
- `{"candidates": ["id1", "id2"]}`, for an uncertain target such as a virtual call.

**Finding.** `severity` (`info`, `warning`, `error`), `message`, optionally `nodes`, `span` and `provenance`.

**Span.** `{"file": "app/billing.ts", "start": [line, column], "end": [line, column]}`. Lines and columns are zero-based.

**Provenance.** `{"frontend": "typescript", "confidence": "exact" | "inferred" | "heuristic"}`, optionally with `mode` (for example `tool-backed` or `static`) and `configuration` (the build configuration the fact belongs to).

Node IDs are chosen by the frontend. The convention is `<file>#<qualified name>`, with children appended, for example `app/billing.ts#charge/call/3`.

## Facets

Facets are optional and declared. A frontend lists the facets it fills, and a lens lists the facets it needs. `structure` is required from every frontend.

| Facet | Models |
|---|---|
| `structure` | Containment: package, module, file, namespace, type, function |
| `packaging` | Imports, exports, includes, build targets, dependency edges |
| `flow` | Control flow inside a function |
| `calls` | Who invokes whom |
| `concurrency` | Things that run alongside other things |
| `sync` | Coordination: locks, semaphores, atomics, condition variables |
| `effects` | Contact with the outside world: fs, net, process, env, clock |
| `state` | Explicit finite state: holders whose type is a finite set of values, the writes that set them, and the tests that compare them |
| `data` | Module-level data: variables, globals and class statics, and the reads and writes of them |
| `x-*` | Open namespace for plugin facets |

## Kinds

A kind is named `<namespace>.<name>`. Core kinds use their facet as the namespace. Plugin kinds must use an `x-<name>.` namespace.

Each kind is declared by a definition with these fields:

- `kind`, `facet`, `on` (`"node"` or `"edge"`)
- `extends` (optional): the kind this one specialises. A query for the parent also returns this kind. Extension must stay in one facet and keep the same `on`.
- `attrs` (optional): a JSON Schema for the kind's own attributes. The effective schema is the combination of this schema and every ancestor's, so the parent's rules still apply. Attribute schemas are open, so extra fields are allowed.
- `composedOf` (optional): the parts a feature is made of, each with `role`, `kind` or `oneOf`, `many`, `optional` and nested `contains`.
- `description` (optional)

A node or edge whose kind has no definition is still stored and reported as **opaque** in the coverage view. It is not dropped.

Base kinds shipped by the core:

| Kind | Facet | On | Extends | Description |
|---|---|---|---|---|
| `structure.package` | structure | node | – | A package or project root. |
| `structure.module` | structure | node | – | A module (one import unit). |
| `structure.file` | structure | node | – | A source file. Created by discovery before any frontend runs. |
| `structure.namespace` | structure | node | – |  |
| `structure.type` | structure | node | – |  |
| `structure.function` | structure | node | – | A function, method or constructor. `attrs.anonymous` marks a function expression, arrow function or lambda with no declaration of its own (named `λ<line>:<col>`); its parent is the enclosing function, or the file at module level. A function-valued property of an object literal bound to a name (a variable, a class property or `export default`) is named `<binding>.<prop>`, as a class member is `Class.member`, and is not anonymous; a literal passed inline keeps its lambdas. `attrs.callbackSlot` is set on each anonymous function by the TypeScript frontend: `true` when it is a callback slot (a lambda passed to a call, or a property of an options bag passed to one), `false` for a property arrow of a returned or stored literal (a named member). Absent on a model from an older frontend, where a stage view falls back to the `λ<line>:<col>` id. Optional `attrs.derives` maps each **local** variable the function declares (not a parameter, and not a local of a nested function) to the distinct local names its initializer and every later assignment (`=`, compound) reads, in first-seen order: `const a = x + 1; a = y` gives `{"a": ["x", "y"]}`. A destructuring target gets the whole right side's reads. A local that reads no local is omitted. The TypeScript frontend emits `derives` on every function, `{}` when none remain, and that key is the data-flow fact a stage view needs: a frontend whose functions carry no `derives` and whose calls carry no `reads` key gives no data edges. Optional `attrs.params` lists the parameter local keys in order, a destructured parameter contributing each name it binds (see "Local name keys"). |
| `flow.block` | flow | node | – | A labelled region: the try, catch or finally part of a try, or a loop body. |
| `flow.branch` | flow | node | – | if / else, or any two-way choice. `attrs.condition` is the condition as written. Optional `attrs.reads` lists the distinct **local** variable names the condition reads (parameters and variables declared inside a function), in first-seen order: `if (cfg.debug && n > 0)` gives `["cfg", "n"]`. Locals only: module variables (`data.variable` targets), globals, imported bindings, member names and called function names are excluded. |
| `flow.branch-arm` | flow | node | – | One arm of a branch or switch: then, else, a case or the default. |
| `flow.switch` | flow | node | `flow.branch` |  |
| `flow.loop` | flow | node | – | `attrs.variant` is `for`, `for-of`, `for-in`, `while` or `do`; optional `attrs.condition` is the condition as written. Optional `attrs.reads` lists the distinct local names the condition or range reads, like `flow.branch` reads: `for (const x of items)` reads `["items"]` (the loop variable is declared, not read), and `while (it != end)` reads `["it", "end"]`. Locals only, as for `flow.branch`. |
| `flow.try` | flow | node | – |  |
| `flow.throw` | flow | node | – | Raises an exception. |
| `flow.return` | flow | node | – | Leaves the enclosing function. |
| `flow.jump` | flow | node | – | break or continue: leaves or restarts the enclosing loop or switch. |
| `packaging.build-target` | packaging | node | – |  |
| `packaging.import` | packaging | edge | – |  |
| `packaging.export` | packaging | edge | – |  |
| `packaging.re-export` | packaging | edge | `packaging.export` | Attrs `names` and `as`. `names` lists the original names the file re-exports (`deepSrc` for `export { deepSrc as midAlias } from`), or `["*"]` for `export *`. `as` gives the exported name of each, by position, and is absent for `export *`. A downstream name maps back through `as` to the `names` entry it came from. |
| `packaging.include` | packaging | edge | – |  |
| `packaging.dep-edge` | packaging | edge | – | A build-level dependency between targets or packages. |
| `packaging.target-contains` | packaging | edge | – | A build target contains a file. |
| `packaging.external` | packaging | node | – | A third-party package the project depends on, such as a Bazel module, a CMake dependency or a Conan package. `attrs` are `name`, `manager` and `source` (all required; `manager` is the owning build or package manager, `source` is how it is obtained, see [Build-system packages](#build-system-packages)), plus `version`, `repoName`, `registry`, `url`, `sha256`, `dev` and `override`. |
| `calls.call-site` | calls | node | – |  |
| `calls.dynamic-dispatch` | calls | node | – |  |
| `calls.callback-registration` | calls | node | – |  |
| `calls.call` | calls | edge | – | Caller function to callee function. A call through an interface member, or an abstract class member, has no body to call, so its `to` is `{"candidates": [...]}` with the implementations (`attrs.how` is `interface`, provenance `heuristic`). The candidates are every indexed class that implements the interface, directly, through an extended interface, or through a base class, and that declares the member or inherits it from its nearest base class; or, for an abstract member, every indexed concrete subclass of the abstract class and what it inherits or overrides. A receiver typed by an interface is matched against that interface's implementers, not the interface that declares the member. A set is sorted by id and holds at most 32 targets; `attrs.truncated` is `true` when the set was cut. A set always has at least one target, even when there is one implementation. Not covered: structural matches (a class that fits an interface without `implements`), classes in files outside the index, class expressions, and a new implementer in another file, which reaches a call site only when that call site's file is extracted again. Optional `attrs.knownState` maps a holder id to the values it is known to hold at the call site, `attrs.knownStale` lists the holders whose value there may be out of date, and `attrs.knownEntry` lists the holders whose known set at the call is exactly the caller's own entry set (no write or test of the holder, and no await, on any path from the caller's entry to the call, and no join with a non-entry set). Optional `attrs.binds` is the local the call's result is bound or assigned to: `const cfg = loadConfig()` and `cfg = loadConfig()` give `"cfg"`, and a destructuring gives an array (`const {a, b} = f()` → `["a", "b"]`). It is a string for one name and an array for several. `await`, parentheses, `as`, `!` and `satisfies` are transparent (`const r = await fetchX()` → `"r"`); a call used anywhere else (an argument, a member, a return) has no `binds`. Optional `attrs.reads` lists the distinct **local** names the receiver and the arguments read, in first-seen order, as `flow.branch` reads does (parameters and variables declared inside a function, including one captured from an enclosing function). A function written as an argument is its own function and is not read; a member name and a called function name are not reads. Optional `attrs.bindsType` is the checker's type of the one local `binds` names, on one line and at most 60 characters (the last one `…`); it is omitted for an `any`, `unknown` or error type. |
| `calls.reference` | calls | edge | – | Caller to a function it refers to without calling it. `attrs.how` is `new`, `jsx`, `value`, `closure` or `handler`. Caller is the enclosing function, or the file for module-level code. `closure` runs from a function to an anonymous function created inside it, so the creator still reaches what the closure calls. `handler` runs from the code that installs a project function as an event or message handler, such as `worker.onmessage = fn` or `addEventListener("message", fn)`, to that function. |
| `calls.contains-call` | calls | edge | – |  |
| `concurrency.spawn-thread` | concurrency | node | – | `attrs.target` names the function run; `attrs.api` (optional) is the exact API that spawns it. |
| `concurrency.spawn-process` | concurrency | node | – | `attrs.target` names the program run; `attrs.api` (optional) is the exact API that spawns it. |
| `concurrency.coroutine` | concurrency | node | – |  |
| `concurrency.async-task` | concurrency | node | – |  |
| `concurrency.await` | concurrency | node | – |  |
| `concurrency.channel-send` | concurrency | node | – | A send on a channel. `attrs.channel` (required) names the queue or channel: a literal name, `Class::member`, or `<dynamic>`; the execution model groups sends and receives by it. Optional `attrs.api` is the exact API, and optional `attrs.guardedBy` names the lock for a queue inferred to be guarded by that lock. |
| `concurrency.channel-recv` | concurrency | node | – | A receive on a channel. `attrs.channel` (required) names the channel, as for a send. Optional `attrs.api` and `attrs.guardedBy` as for a send. |
| `concurrency.spawns` | concurrency | edge | – | Spawn node to the function (or script file) it runs. `attrs.how` is `thread`, `process` or `async`. The spawning function is the spawn node's owner. Only emitted when the target resolves. |
| `concurrency.dispatches` | concurrency | edge | – | Function to the coroutine, async function or callback it hands work to. `attrs.how` is `await`, `start`, `callback`, `timer`, `microtask` or `message`. `message` is a Web Worker `postMessage` (page to worker, or worker to page) to the `onmessage` or `addEventListener("message")` handler the other side registers at its top level or on the Worker object; the TypeScript frontend emits it only when both ends resolve, with confidence `inferred`. |
| `sync.lock-acquire` | sync | node | – | Takes a lock. `attrs.lock` names the lock; the execution model and the lock-order lens group acquires by it. |
| `sync.lock-release` | sync | node | – |  |
| `sync.rwlock-acquire` | sync | node | `sync.lock-acquire` | `attrs.mode` and `attrs.lock` are required. `attrs.mode` is `shared` or `exclusive`, and `attrs.lock` names the mutex. |
| `sync.semaphore` | sync | node | – | `attrs.op` (required) is `acquire`, `release`, `wait`, `notify` or `op`. Optional `attrs.name`, `attrs.lock` (the lock the operation is tied to) and `attrs.api`. |
| `sync.atomic-op` | sync | node | – | `attrs.op` (required) is `acquire`, `release`, `wait`, `notify` or `op`. Optional `attrs.lock` and `attrs.api`. |
| `sync.condvar` | sync | node | – | `attrs.op` (required) is `acquire`, `release`, `wait`, `notify` or `op`. Optional `attrs.lock` and `attrs.api`, e.g. `wait` with `lock` `m_`. |
| `state.holder` | state | node | – | A field, variable or useState slot whose declared type is a finite set of values (enum or literal union). |
| `state.write` | state | node | – | One site that sets a holder: an assignment, an object-literal property, an initializer, or a call to a setter helper. `from` is the set of values the holder is known to have just before. `fromEntry: true` (only when `from` is absent) says the known set at the write is exactly the enclosing function's entry set, so a consumer may fill it from the callers; a write without `from` and without `fromEntry` is unknown for another reason (dynamic write, join with an unknown side, loop widening, stale after an await). |
| `state.test` | state | node | – | One comparison of a holder against literal values (`===`, `!==`, `==`, `!=`, or a switch case group), with the branch arms where it holds or doesn't. |
| `data.variable` | data | node | – | A module-level `let`, `var` or `const`, a global written through `globalThis`, `window` or `self`, or a class `static` field. Parent is the file, or the class for a static. Required attrs are `name`, `qualifiedName`, `storage`, `exported` and `mutable`; see below. |
| `data.read` | data | edge | – | A function (or the file, for module-level code) reads a `data.variable`. |
| `data.write` | data | edge | – | A function (or the file, for module-level code) writes a `data.variable`. `attrs.how` is `assign` (`=`), `update` (`++`, `--`, `+=` and the other compound assignments), `mutate` (a mutating method such as `set` or `push`, or a property or element assignment through the variable; heuristic provenance) or `address`. |
| `effects.fs.read` | effects | node | – | Optional `attrs.syscall`, see below. |
| `effects.fs.write` | effects | node | – | Optional `attrs.syscall`, see below. |
| `effects.net.connect` | effects | node | – | Optional `attrs.protocol`, `sse` or `websocket`, for a long-lived connection (unset for plain request/response), and optional `attrs.syscall`, see below. |
| `effects.net.listen` | effects | node | – | Optional `attrs.syscall`, see below. |
| `effects.net.serve` | effects | node | – | An HTTP route a file serves: registered on a server object, or exported under an HTTP verb name. Required `attrs.framework`, `attrs.method` and `attrs.path`. Optional `attrs.handler`, `attrs.platform` (hosting platform, e.g. `cloudflare`), `attrs.name` (the deployable that serves the route) and `attrs.syscall`. |
| `effects.store.access` | effects | node | – | A read, write, list or delete on a storage service. Required `attrs.api`, `attrs.store` (e.g. `cloudflare-kv`, `cloudflare-r2`, `cloudflare-d1`) and `attrs.op`, one of `read`, `write`, `list` or `delete`. Optional `attrs.binding` (the platform binding name, e.g. `INDEX`), `attrs.name` and `attrs.syscall`. |
| `effects.proc.exec` | effects | node | – | Optional `attrs.syscall`, see below. |
| `effects.env.read` | effects | node | – | Optional `attrs.syscall`, see below. |
| `effects.clock.read` | effects | node | – | Optional `attrs.syscall`, see below. |
| `effects.message.post` | effects | node | – | A message posted to a peer (postMessage) from a page or worker. Required `attrs.api`. Optional `attrs.syscall`, see below. |
| `effects.os.call` | effects | node | – | An OS operation that is not a resource kind: signals, process control, memory mapping, device control, raw syscall, OS info, fd-level ops. Matched only from catalog entries naming an exact API. Required `attrs.api` (exact API, e.g. `process.kill`, `mmap`) and `attrs.op`, one of `signal`, `process-control`, `memory`, `device`, `raw-syscall`, `info` or `fd`. Optional `attrs.syscall` (kernel call it maps to 1:1, e.g. `kill`) and `attrs.target` (literal signal name, fd or path, or `<dynamic>`). |
| `effects.unknown` | effects | node | – | An external call no catalog recognises. Kept rather than dropped. Optional `attrs.syscall`, see below. |

Every `effects.*` kind accepts an optional `attrs.syscall`: the kernel call this API wraps 1:1 (e.g. `unlink`, `connect`, `execve`). It is unset for high-level APIs.

`effects.os.call` requires `attrs.api` and `attrs.op`. `attrs.op` is one of `signal`, `process-control`, `memory`, `device`, `raw-syscall`, `info` or `fd`. The schema is `packages/core/ir/schema/facets/effects.schema.json`, `EffectsOsCall`.

Other attributes added with the System tab, all from the same schema files:

| Kind | Attribute | Required | Notes |
| --- | --- | --- | --- |
| `concurrency.spawn-thread`, `concurrency.spawn-process` | `api` | no | The exact API that spawns it. |
| `concurrency.channel-send`, `concurrency.channel-recv` | `channel` | yes | Literal name, `Class::member`, or `<dynamic>`. |
| | `api` | no | The exact API. |
| | `guardedBy` | no | The lock an inferred guarded queue is held under. |
| `sync.semaphore` | `op` | yes | `acquire`, `release`, `wait`, `notify` or `op`. |
| | `name`, `lock`, `api` | no | `name` is the semaphore's name; `lock` is the mutex it is tied to. |
| `sync.condvar` | `op` | yes | As for `sync.semaphore`. |
| `state.holder` | state | node | – | A field, variable or useState slot whose declared type is a finite set of values (enum or literal union). |
| `state.write` | state | node | – | One site that sets a holder: an assignment, an object-literal property, an initializer, or a call to a setter helper. `from` is the set of values the holder is known to have just before. `fromEntry: true` (only when `from` is absent) says the known set at the write is exactly the enclosing function's entry set, so a consumer may fill it from the callers; a write without `from` and without `fromEntry` is unknown for another reason (dynamic write, join with an unknown side, loop widening, stale after an await). |
| `state.test` | state | node | – | One comparison of a holder against literal values (`===`, `!==`, `==`, `!=`, or a switch case group), with the branch arms where it holds or doesn't. |
| | `name`, `lock`, `api` | no | `name` is the condvar's name. |
| `sync.atomic-op` | `op` | yes | As for `sync.semaphore`. |
| | `lock`, `api` | no | |
| `sync.rwlock-acquire` | `mode` | yes | `shared` or `exclusive`. |
| | `lock` | yes | The mutex name the lock is taken on. |

### Local name keys

A local variable is named in `binds`, `reads`, `argReads`, `derives` (keys and values) and `params` by its **local key**, so two locals that share a name in one function stay apart:

- A name its function declares once is the bare name: `items`.
- A name declared more than once in one function (shadowing, or the same name in sibling blocks or loops) is `name@line`: the 1-based line of the declared identifier. When two of those declarations share a line, it is `name@line:col` (1-based column).
- The key is resolved through the checker, so every use of one local gives the same key everywhere in its function.

Display strips the `@…` suffix. The stage model shows `f` for `f@12`.

`calls.call` `attrs.argReads` gives the locals each positional argument reads: one list per argument, in order, keyed as above. It is emitted only when some argument reads a local. `attrs.argSpread` is the index of the first spread argument; the parameters from that position on take the spread argument's reads. A stage model maps a helper parameter at position `i` to `argReads[i]`. Without `argReads` it falls back to the call's whole `reads`, and marks the stage graph "Helper arguments approximate".

### data.variable attributes

| Kind | Attribute | Required | Notes |
| --- | --- | --- | --- |
| `data.variable` | `name`, `qualifiedName` | yes | `qualifiedName` is `Class.name` for a static, `globalThis.name` (or `window`, `self`) for a global, and `name` otherwise. |
| | `storage` | yes | `global`, `module`, `file-static`, `function-static`, `class-static` or `extern-decl`. |
| | `exported`, `mutable` | yes | `exported` is true when the variable is visible outside its file. `mutable` is true for a `let` or `var`, for a class static that is not `readonly`, and for every global. A `const` is mutable only when its initializer can hold state: a literal, a `new` expression or a call result. A frozen (`Object.freeze(…)`) or `as const` literal is not. |
| | `constBound` | no | `true` on a `const` whose initializer is a mutable container (`mutable` is true). The flow layer counts it as state only when some function writes it, through a property, an element, a mutating call or a destructuring target. |
| | Global id and parent | – | A global's id is `<global>#global:<name>`, with no file part and no parent. Each file that writes the global emits the same node. Its `qualifiedName` is always `globalThis.<name>` (whatever head the write used), and its span is the first write in the lexicographically first writing file. A read of a global is recorded only when some project file writes it, and each reader depends on every writer, so a removed writer drops the read. Incrementally, when a new writer of a global or variable is added, existing readers get the edge only after a full re-index: the edge is missing until then, never dangling, the same as for calls. |
| | `type` | no | The declared type, when known. |

### Which frontend emits each kind

The fact rules that turn these kinds into System-view edges are in `docs/system-view.md`, under "Fact rules". This table says only which frontend emits each kind today.

| Kind | TypeScript (`packages/frontend/typescript`) | C++ (`packages/frontend/cpp`) |
| --- | --- | --- |
| `effects.fs.read`, `effects.fs.write` | catalog `data/effects.json` | catalog `data/effects.json`, and `src/extract.ts` |
| `effects.net.connect`, `effects.net.listen` | catalog `data/effects.json` | `net.connect`, `net.listen` in the catalog |
| `effects.net.serve` | `src/effects.ts` | not emitted |
| `effects.proc.exec` | catalog, and `src/extract.ts` | catalog |
| `effects.env.read` | `src/extract.ts` | catalog |
| `effects.clock.read` | catalog | catalog |
| `effects.message.post` | `src/extract.ts` | not emitted |
| `effects.os.call` | catalog (19 rows) | catalog (16 rows) |
| `concurrency.spawn-thread`, `concurrency.spawn-process` | `src/extract.ts` | `spawn-process` in the catalog; `spawn-thread` in `src/extract.ts` |
| `concurrency.channel-send`, `concurrency.channel-recv` | `src/extract.ts` (`MessageChannel`, `BroadcastChannel`) | `src/extract.ts` (queue methods) |
| `sync.lock-acquire`, `sync.lock-release`, `sync.rwlock-acquire` | catalog (`lock-acquire`); `navigator.locks` | `src/extract.ts` |
| `sync.semaphore` | not emitted | `src/extract.ts` |
| `sync.condvar`, `sync.atomic-op` | catalog | `src/extract.ts` |
| `data.variable`, `data.read`, `data.write` | `src/data.ts` | `src/data.ts` |
| `state.holder` | state | node | – | A field, variable or useState slot whose declared type is a finite set of values (enum or literal union). |
| `state.write` | state | node | – | One site that sets a holder: an assignment, an object-literal property, an initializer, or a call to a setter helper. `from` is the set of values the holder is known to have just before. `fromEntry: true` (only when `from` is absent) says the known set at the write is exactly the enclosing function's entry set, so a consumer may fill it from the callers; a write without `from` and without `fromEntry` is unknown for another reason (dynamic write, join with an unknown side, loop widening, stale after an await). |
| `state.test` | state | node | – | One comparison of a holder against literal values (`===`, `!==`, `==`, `!=`, or a switch case group), with the branch arms where it holds or doesn't. |

`effects.unknown` and the C++ `concurrency.async-task` are not emitted by any frontend.

`calls.reference` has no parent on purpose. A query for a parent also returns its extensions, so extending `calls.call` would make every call query return references too.

## Build-system packages

Every build-system frontend (Bazel, CMake, Ninja, Make, and so on) fills the same contract, so the core reads each one the same way. The contract is open: a frontend may name its own `manager`, `source`, `override` and `targetKind` values, and the core accepts any non-empty string for them.

- **`structure.package`** `{name, root, buildSystem}`: one node per package directory. `root` is the directory relative to the repository root, and `buildSystem` names the frontend's build system. Ids are scoped by the frontend so that two build systems can describe the same directory without a clash: `//lib` for a Bazel package, `cmake:lib` for a CMake one.
- **`packaging.build-target`** `{name, label, targetKind, output, visibility?}`: one node per build target. `label` is the target's full name in its build system, `targetKind` is the build system's own rule or command name (for example `cc_binary` or `add_library`), and `output` is one of `executable`, `library`, `test` or `other`. The core uses `output` to decide what counts as a program; when it is absent, the core falls back to matching the name.
- **`packaging.target-contains`**: an edge from a build target to a file it compiles or otherwise owns.
- **`packaging.dep-edge`**: an edge from a build target to another build target, or to a `packaging.external` node when the dependency is third-party.
- **`packaging.external`** `{name, version?, manager, source, override?, ...}`: one node per third-party package. `manager` is the package manager that owns it (`bazel`, `cmake`, `conan`, `vcpkg`, `npm`, …). `source` says how it is obtained (examples: `bzlmod`, `workspace`, `lockfile`, `find_package`, `FetchContent`, `pkg-config`, `vendored`). `override` says how a version override is applied (examples: `git`, `archive`, `local`, `single_version`, `multiple_version`).
- **`cpp.include` resolver role**: a build system that knows which package owns an include answers the `cpp.include` reference itself, and leaves `fallback` unset. The syntactic C++ resolver (`packages/frontend/cpp`) is a guesser and declares `fallback: true`, so the core uses its answers only when no build-system resolver answered.

Packages from several build systems are merged by `root`: two `structure.package` nodes with the same `root` describe one package. The core keeps one package per directory, and takes its display name from the node whose `buildSystem` sorts first (a node without `buildSystem` sorts last), with ties broken by node id, so the result does not depend on record order.

## Writing a kind definition

A plugin supplies definitions in a JSON file named by the `kinds` field of its manifest, or in its frontend's `defines` list. For example, a Go `select` statement could be declared as:

```json
{
  "kind": "x-go.select",
  "facet": "flow",
  "on": "node",
  "extends": "flow.branch",
  "attrs": { "type": "object", "properties": { "hasDefault": { "type": "boolean" } } },
  "composedOf": [
    { "role": "case", "kind": "flow.branch-arm", "many": true,
      "contains": [{ "role": "guard", "oneOf": ["concurrency.channel-send", "concurrency.channel-recv"] }] }
  ]
}
```

Definitions from every plugin are merged into one registry. Each batch is checked as a whole. If any definition is invalid, the whole batch is rejected and the error names the plugin. Conflicts, missing parents and parent cycles are all reported with the plugin ids involved.

## Validating a file

`validateIR(text, registry)` from `@insight/ir` parses NDJSON, checks each record against the core schema, checks each node and edge against its kind (facet, role, attributes), and by default requires every parent and edge endpoint to exist inside the same document. The result lists each problem with its line number.

## Versioning

Plugins declare the IR format version they target in their manifest (`irVersion`), and the loader rejects a mismatch with a message. Individual facets are not versioned yet; that is future work.
