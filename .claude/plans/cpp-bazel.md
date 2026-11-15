# C++ + Bazel (Bazel as the package manager)

Status: plan, not started. Repo `~/deploy/insight`, base master. Written 2026-11-14.

## Where we are

Already on master:

- `packages/frontend/cpp` (`frontend-cpp` 0.1.0, tree-sitter, syntactic): structure, calls, flow, effects,
  concurrency, sync, `packaging.include` edges with `cpp.include` unresolved refs. Calls resolve **project-wide by
  qualified name** (`project.ts` `byQName`/`bySimple`); ambiguous names become `candidates` (heuristic).
  Fallback include resolver (priority 10): relative, then unique path suffix.
- `packages/frontend/bazel` (`frontend-bazel` 0.1.0, own Starlark tokenizer, no `bazel` binary): `cc_*` and
  `*_binary` rules from BUILD/BUILD.bazel -> `packaging.build-target` nodes (id `//pkg:name`),
  `packaging.target-contains` (srcs/hdrs, globs expanded), `packaging.dep-edge` (in-repo deps; `@repo//…`
  labels left as `bazel.label` unresolved refs that **no resolver answers**). Include resolver (priority 90)
  answers `cpp.include` through target `includes`, `strip_include_prefix`, `include_prefix` over the deps closure.
- Core flow `exec-model.ts:618` already turns `*_binary` / `add_executable` build targets into programs, with
  `main` found in the target's files. cc_test targets are noise at the root.

Missing for "Bazel tracks package management":

1. **External packages are not modeled.** No MODULE.bazel (`module`, `bazel_dep`, `*_override`, `use_repo`),
   MODULE.bazel.lock, or WORKSPACE (`http_archive`, `git_repository`, `local_repository`) parsing. `@abseil-cpp//absl/strings`
   is a dangling unresolved ref; includes of `absl/strings/str_cat.h` stay unresolved (or worse, the suffix
   resolver guesses a vendored copy).
2. **Bazel packages are not Arch/System packages.** `arch.ts packageRoots` reads `structure.package` nodes
   (nobody emits them) or `package.json`; `system.ts packageRoots(files)` reads `package.json` only. A Bazel repo
   gets generic top-directory layers.
3. **Declared deps aren't used.** Arch edges come from imports/includes/calls; `packaging.dep-edge` is only read by
   `indexer/diff.ts` (diff summary). No "declared vs used" view.
4. **Call resolution ignores the build graph.** Two `cc_binary`s each with `void Init()` -> every call is a
   2-candidate heuristic edge, though Bazel says the caller can only link one.
5. **Freshness bug.** BUILD batches depend on the file list (globs) and on other BUILD files (subpackage
   exclusion, `model.targets.has(dep)`), but the manifest declares no `inputs` and batches no `dependsOn`, so
   adding `lib/src/new.cc` leaves `//lib:core`'s `target-contains` stale until a full reindex.
6. **Macros / custom rules.** `my_cc_library(...)` from a `.bzl` file is invisible; no tool mode (`source: "tool"`
   exists in the schema but is never produced).
7. `visibility` is not read.

## Does the core need to change?

Yes, but only in small, build-system-agnostic ways. Nothing Bazel-specific goes into core; the `Frontend`
contract, loader, pipeline, merkle/shards and resolver protocol stay as they are.

| Core area | Change | Why it can't live in the frontend |
|---|---|---|
| `ir` kinds | **New kind `packaging.external`** (node): a third-party package with name/version/source | Arch/System (core model) must read externals generically; npm `dependencies` can use it later. A frontend-defined kind would make core depend on Bazel names. |
| `model` | `system.ts packageRoots` reads `structure.package` nodes (as `arch.ts` already does), externals from `packaging.external` nodes + resolved edges, declared edges from `packaging.dep-edge` | Model code is core; today it hard-codes `package.json`. |
| `indexer/linker.ts` | **Build-visibility pruning pass** after resolvers: narrow `calls.call` candidates to the caller target's closure | Needs the linked graph (both frontends' facts); frontends run independently and must not import each other. Generic over `target-contains` + `dep-edge`, so CMake benefits too. |
| `flow/exec-model.ts` | Program display name from the label when names collide (`//tools/a:main` vs `//tools/b:main`) | Small; same place that already reads build targets. |

Not needed in core: pipeline `inputs` (already exists; the Bazel manifest just has to use it), SDK, resolvers.

## Decisions (proposed, need your OK)

- **D1 Bazel package = directory with a BUILD file.** The Bazel frontend emits `structure.package`
  `{ name: "//lib", root: "lib" }` per BUILD file (root package `//` -> root "."). Targets stay
  `packaging.build-target` children (`parent` = package id). Arch "Packages" boxes = Bazel packages; targets show on
  drill-down. (Alternative: target = box. Rejected as the default: abseil has ~700 targets.)
- **D2 External package node.** Core kind `packaging.external`, id `@<apparent repo name>` (e.g. `@abseil-cpp`,
  or `@com_google_absl` when `repo_name` is set), attrs `{ name, version?, repoName?, source: "bzlmod" | "workspace"
  | "lockfile", registry?, url?, sha256?, dev?: boolean, override?: "git" | "archive" | "local" | "single_version" }`.
  Precedence: MODULE.bazel.lock (exact resolved version) > MODULE.bazel > WORKSPACE. Provenance `exact` for literal
  calls, `heuristic` for WORKSPACE repos declared inside `load()`ed macros we can't expand (name only).
- **D3 Labels resolve to externals.** The Bazel frontend emits the external nodes itself, so a `@repo//…` dep
  edge points straight at the `@repo` node (exact when the repo is declared, `bazel.label` unresolved when it
  isn't). No second resolver: a manifest has exactly one `roles.resolver` (`indexer/src/manifest.ts:26`), already
  used for `cpp.include`, and none is needed. In-repo labels no target declares stay unresolved.
- **D4 External includes.** The Bazel include resolver, when no in-repo header matches and the owning target's
  closure has external deps, answers with the external node whose name best matches the include's first segment
  (`absl/…` -> `@abseil-cpp`, `gtest/…` -> `@googletest`), confidence `heuristic`, a small built-in alias table
  (absl, gtest/gmock, benchmark, protobuf/google/protobuf, grpc/grpcpp, fmt, spdlog, nlohmann, boost, re2, glog,
  gflags) plus "single external dep" fallback. The suffix resolver must not beat it with a vendored copy outside the
  closure (priority 90 already wins; add a test).
- **D5 Visibility pruning (core, generic).** After resolvers, for each `calls.call` edge with `candidates`:
  owners(caller file) via `target-contains`; allowed = owners ∪ transitive `dep-edge` closure; keep candidates whose
  file is owned by an allowed target (headers count through `hdrs`). If that leaves 1 → plain target, confidence
  `inferred`, `provenance.note` "narrowed by build graph"; if it leaves 0 or the caller has no owner → unchanged.
  Never invents edges. Behind an indexer option, default on; counted in the run summary ("N calls narrowed").
- **D6 Freshness.** Bazel manifest `inputs`: `**/BUILD`, `**/BUILD.bazel`, `MODULE.bazel`, `MODULE.bazel.lock`,
  `WORKSPACE`, `WORKSPACE.bazel`, `**/*.bzl` plus the C++/source globs that `glob()` can match. Any source edit then
  re-extracts all BUILD files; BUILD parsing is milliseconds per file, so accept it, measure in P0. (Core
  alternative if too slow: an `inputs` mode that hashes paths, not contents. Only if P0 says so.)
- **D7 Unknown rules.** A top-level call whose args include `srcs`/`hdrs` and `deps` and whose name isn't a known
  non-C++ rule becomes a build target with `targetKind` = the macro name, provenance `heuristic` (catches
  `my_cc_library`, `envoy_cc_library`, `absl_cc_library`-style wrappers). `*_test` stays noise.
- **D8 Tool mode (optional).** With `allowBuildTools`, run `bazel query 'kind(rule, //...)' --output=streamed_jsonproto`
  (and `bazel mod graph --output=json` for externals) and emit `source: "tool"`, `exact`. Off by default; never in
  hosted. Static mode stays the default path everywhere.
- **D9 Declared vs used.** Arch package edges get `declared: boolean` (from `dep-edge`) next to the existing
  imports/calls counts. The Dependencies lens adds Bazel rules: *undeclared dependency* (include/call into a target
  outside the closure, Bazel's layering_check), *unused dep* (declared, no include/call), *visibility violation*
  (dep onto a target whose `visibility` excludes the caller's package).

## Phases (each needs your go)

- **P0 Probe** (no code merged). Index 3 repos at fixed SHAs on a test server: `bazelbuild/examples` (cpp-tutorial
  stage1–3, tiny, binaries), `google/googletest` (bzlmod, tests), `abseil/abseil-cpp` (bzlmod, ~700 targets, macro
  wrappers `absl_cc_library`). Report: targets found vs hand count / `bazel query` (if bazel installed), % includes
  resolved, # `calls.call` with candidates and how many D5 would narrow, index time, BUILD re-extract cost per edit
  (D6). Output a table in the plan; it gates D6/D7 choices.
- **P1 IR kind** (core/ir): `packaging.external` in `core.kinds.json` + `packaging.schema.json`
  `PackagingExternal`, regenerate `generated/packaging.ts`, IR minor version, `docs/ir-reference.md`.
- **P2 Bazel frontend** (frontend-bazel 0.2.0): D1 packages, D2 MODULE.bazel / lock / WORKSPACE parsing (extend
  `starlark.ts` for keyword args already there; lock file is JSON), D3 direct dep edges to external nodes, D4 include → external, D6 `inputs`, D7 unknown rules,
  `visibility` attr on build targets. Fixtures: extend `sample-bazel` with MODULE.bazel(+lock), a macro, an external
  include; goldens updated.
- **P3 Linker pruning** (core/indexer): D5, unit tests on a synthetic graph + the bazel fixture with two binaries
  defining `Init()`. Also run on the TS repo to prove no change when there are no build targets.
- **P4 Model** (core/model + flow): `system.ts packageRoots` from `structure.package` nodes (fall back to
  package.json), `archModel` externals from `packaging.external` + edges resolved to them (keep the bare-specifier
  heuristic for TS), D9 `declared` on `ArchEdge`, exec program names disambiguated by label.
- **P5 Lens** (lens/dependencies): D9 rules, findings with spans on the BUILD `deps` entry and the offending include.
- **P6 Web**: Arch Packages shows Bazel packages + an externals column grouped by module with version chips;
  declared-only edges dashed, used-but-undeclared edges in the warning colour; BUILD/MODULE.bazel in the Code pane
  (Starlark highlighting if the in-flight `Syntax.tsx` work lands — coordinate, it's uncommitted in the shared
  checkout).
- **P7 Docs + e2e**: `docs/writing-a-frontend.md` (Bazel example), `docs/arch-view.md`; screenshots on the three
  probe repos; hosted check (tarball index of abseil-cpp within the 300 s function limit; KV quota).
- **P8 (optional) Tool mode** D8.

DAG: P0 → everything. P1 → P2, P4. P2 → P5, P7. P3 independent of P2 (generic; uses fixtures) → P5.
P4 → P6. P5 + P6 → P7. P8 after P2.

## Out of scope

C++ semantic precision unrelated to Bazel (overloads, templates, macros, `obj.f()` method resolution, `using`),
`select()` evaluation (all branches are taken today; keep), toolchains/platforms, `copts`/`defines`, non-C++ Bazel
languages beyond the existing `*_binary` program detection, other C++ package managers (Conan, vcpkg).

## Risks

- Real repos lean on macros (abseil, envoy, tensorflow); static D7 is heuristic. Tool mode is the precise path
  but unavailable in hosted.
- WORKSPACE repos mostly come from `load("//bazel:deps.bzl", "deps"); deps()` — static parsing sees only names
  through `use_repo`/labels. bzlmod repos (most active projects since Bazel 7) are the main target.
- D5 can hide a real call if the build graph is wrong (e.g. macro-made deps we missed). Only narrow, never drop
  to zero, and say so in provenance.
