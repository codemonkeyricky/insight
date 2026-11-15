# Build systems

In C++ a package boundary and a third-party dependency only exist in the build. A file's `#include` tells you a header
name, not which package owns it or where it comes from. Insight reads that from the build system: a build-system
frontend emits packages, targets, what each target contains, what it depends on, and its third-party packages. The core
reads those facts the same way for every build system, so the Arch view, the lenses and the call graph do not know
which build system produced them.

Two frontends do this today: [Bazel](../packages/frontend/bazel) (`@insight/frontend-bazel`) and
[CMake](../packages/frontend/cmake) (`@insight/frontend-cmake`). Both read the build files statically. Neither runs
`bazel`, `cmake` or any other tool. The IR side of the contract is in [ir-reference.md](ir-reference.md#build-system-packages).

## The contract

| Fact | IR record | What it means | Set by |
|---|---|---|---|
| Package | `structure.package` `{name, root, buildSystem}` | One per package directory. Bazel: `//lib`, the root is `//`. CMake: `cmake:lib`, the root is `cmake:.` | Each frontend, one per directory |
| Target | `packaging.build-target` `{name, label, targetKind, output, source, visibility?}` | A library, binary, or test. `output` is `executable`, `library`, `test` or `other`. `source` is `static` or `tool` | Each frontend |
| Membership | `packaging.target-contains` target → file | The file is compiled into or owned by the target | Each frontend |
| Declared dependency | `packaging.dep-edge` target → target, → external, or unresolved | The target depends on another target or a third-party package | Each frontend |
| Third-party package | `packaging.external` `{name, source, manager, version?, override?, ...}` | A package the build declares: `manager` is the build system, `source` is how it is obtained | Each frontend |
| Include owner | `cpp.include` resolver | Which package or header an `#include` names | Each frontend, through a resolver |

The `cpp.include` resolver of a build system leaves `fallback` unset. The C++ syntactic resolver in `packages/frontend/cpp`
sets `"fallback": true`, so its guesses are used only when no build-system resolver answered. See
[writing-a-frontend.md](writing-a-frontend.md#resolvers).

`manager`, `source`, `override` and `buildSystem` are open strings. The values below are the ones the two frontends use.

## Bazel (`frontend-bazel`)

### What it reads

| File | Used for |
|---|---|
| `BUILD`, `BUILD.bazel` | Packages (one per file), the targets they declare, and `package(default_visibility)` |
| `MODULE.bazel` | `bazel_dep` (external modules), `use_repo` (repositories an extension makes), the `*_override` calls |
| `MODULE.bazel.lock` | The exact resolved version of each module (a JSON file). When it names a version, it wins over `MODULE.bazel` |
| `WORKSPACE`, `WORKSPACE.bazel` | Repository rules at the top level: `http_archive`, `git_repository`, `local_repository` and their `new_*` forms |
| `*.bzl` | Not parsed. A macro defined there is seen only through its calls in a BUILD file |

Detection looks up to three directories down for a BUILD file. The root's `MODULE.bazel` or `WORKSPACE` also counts.

### Targets and output

| Rule | Target | `output` |
|---|---|---|
| `cc_library` | yes | `library` |
| `cc_binary`, any `*_binary` (for example `py_binary`) | yes | `executable` |
| `cc_test`, any `*_test` the frontend reads (cc only) | yes | `test` |
| Other `cc_*` rules | yes | `other` |
| Any other top-level call with `deps` and `srcs` or `hdrs` (a macro or custom rule) | yes, `confidence: heuristic` | `library` when it has headers or no `main`, else `other` |
| Other `*_test` rules, `filegroup`, `alias`, `genrule`, and the other non-target rules the frontend lists | no | — |

A non-cc binary's `main` file is one of its sources. Only `cc_*` rules record their headers, include directories, `strip_include_prefix` and `include_prefix`, and their `deps` and external labels as dependencies.

### Packages, labels and dependencies

- A target's id is its label, `//pkg:name`. Its `parent` is the package node.
- `srcs`, `hdrs` and `glob()` expand to repository files. A directory with its own BUILD file belongs to that package, not to the glob above it.
- For a `cc_*` target, an in-repository `deps` label that names a target becomes a `dep-edge` to that target. A label that names no target becomes a `dep-edge` to `{unresolved: bazel.label}`, which no resolver settles. A non-cc binary records only the deps that name a known target.
- For a `cc_*` target, a `@repo//…` label becomes a `dep-edge` to the `@repo` external node when the repository is declared. Otherwise it is unresolved.

### External packages

| Declared by | External id | `source` | Notes |
|---|---|---|---|
| `bazel_dep(name, repo_name?, version?, dev_dependency?)` | `@<repo_name or name>` | `bzlmod` | `dev: true` for a dev dependency |
| `use_repo(...)` for a repository no `bazel_dep` names | `@<repo>` | `bzlmod` | Confidence `inferred` |
| `MODULE.bazel.lock` | same id | `lockfile` | Sets the version. Only a single resolved version counts |
| `git_override`, `archive_override`, `local_path_override`, `single_version_override`, `multiple_version_override` | same id | — | `override` is `git`, `archive`, `local`, `single_version` or `multiple_version`. `url` for git and archive, `version` for single_version |
| `http_archive`, `git_repository`, `local_repository` and `new_*` in WORKSPACE | `@<name>` | `workspace` | A MODULE.bazel declaration of the same id wins |

Repositories declared inside a macro in a `.bzl` file are not read.

### Visibility

A target's `visibility` attribute is read, or the package's `default_visibility` when the target has none. Entries are kept as absolute labels. The lens reads them (see below).

### Include resolution

The Bazel resolver answers `cpp.include` at priority 90:

1. It takes the owner targets of the including file and their dependency closure inside the repository.
2. An include matches a header through the include directories of those targets, or through a header's exposed path (`strip_include_prefix`, `include_prefix`). The answer is `inferred`.
3. When no header matches, it answers with an external node the closure depends on, whose name or `repo_name` matches the first segment of the path, or whose alias matches (see [Aliases](#aliases-for-well-known-packages)). The answer is `inferred`. With no owner target, any declared external may match, and the answer is `heuristic`.

### select() and macros

- `select()` is not evaluated. Every branch's labels are read as if all were taken.
- A macro or custom rule that the frontend does not know is read as a heuristic target, when it has `deps` and `srcs` or `hdrs`. Its sources are the files its arguments name, so a macro that builds its own rules is not seen.

## CMake (`frontend-cmake`)

### What it reads

Every `CMakeLists.txt` in the project, read as text with the commands in order. It follows:

| Command | Effect |
|---|---|
| `add_library`, `add_executable` | A target. Its sources are the arguments that are not keywords. `add_library(x INTERFACE)` is a target too. `IMPORTED` targets are skipped |
| `add_library(alias ALIAS real)` | An alias, followed when a link names `alias` |
| `target_sources`, `target_include_directories`, `target_link_libraries` | Sources, include directories and links, with `PUBLIC`, `PRIVATE` and `INTERFACE` scopes |
| `add_test` | Marks the executable it names (`COMMAND target`) as a test |
| `find_package(name [version])` | An external package, `source: find_package` |
| `FetchContent_Declare(name ...)` | An external package, `source: FetchContent`, with `GIT_TAG` as its version and `URL_HASH` as its sha256 |
| `project(name)` | The name of the root package |
| `file(GLOB)`, `file(GLOB_RECURSE)`, `list(APPEND)`, `set()`, `macro()`, `function()` | Expanded, so their results feed the commands above |

`ExternalProject_Add` and `add_subdirectory` of a directory outside the tree mark the project as having code the reader cannot see.

### Targets and output

- A target id is `cmake://<directory>:<name>`. Its package is the directory of the `CMakeLists.txt` that declares it. A package is emitted only for a directory whose `CMakeLists.txt` declares a target.
- `add_library` is `library`. `add_executable` is `test` when `add_test` names it or its name matches `(^|_)tests?$` or `^test_`, else `executable`.
- Sources are `target-contains` edges with confidence `exact`. Headers under a target's include directories (not the root) are also `target-contains`, with confidence `inferred`, since no file lists them.
- Each link is a `dep-edge`. A link to an alias is followed to its real target. A link named `ns::name` goes to the external package whose name is `ns`.

### Bare system libraries

`target_link_libraries` drops the flags that start with `-` and these names, always: `pthread`, `m`, `dl`, `rt`, `c`, `stdc++`, `atomic`, `ws2_32`, `shlwapi`, `kstat`. Any other bare name (no path, no `::`) that is neither a target, an alias nor a declared external is also dropped, but only when the project fetches or builds no code from outside the tree. When it does, that name stays as an unresolved `cmake.target` dependency, which leaves the target's closure open.

### External packages

| Declared by | External id | `source` | `version` |
|---|---|---|---|
| `find_package(name [version])` | `cmake:pkg:<name>` | `find_package` | the version, only when it is numeric (`1.2.3`) |
| `FetchContent_Declare(name ...)` | `cmake:pkg:<name>` | `FetchContent` | `GIT_TAG` |

Both have `manager: cmake`. `url` comes from `GIT_REPOSITORY` or `URL`, and `sha256` from `URL_HASH`.

### Include resolution

The CMake resolver answers `cpp.include` at priority 80:

1. It takes the owner targets of the including file. An include matches a header in one of their include directories, or in those of the libraries they link through public links. The answer is `inferred`.
2. Otherwise it answers with an external package the owners' closure links (by `ns::name`), or one whose name or alias matches the include. The answer is `inferred`. With no owner, any declared external may match, and the answer is `heuristic`.

### Not evaluated

`if()` and `foreach()` bodies are read in full, so every branch counts. Generator expressions are read only for `BUILD_INTERFACE`, and other `$<...>` items are dropped. Variables from a parent directory are not visible in a subdirectory. `PARENT_SCOPE` is not honored. No platform condition is evaluated.

## Two build systems in one repository

Arch packages are merged by `root`. Two `structure.package` nodes with the same root describe one package. Its name comes from the node whose `buildSystem` sorts first, and a node without one sorts last. Ties go to the lower node id, so the result does not depend on record order. The rule is in `packageRoots` (`packages/core/model/src/arch/arch.ts`). Package.json roots are added after, only for directories that no build-system package already names.

## Narrowing calls by the build graph

A C++ call whose target is ambiguous becomes a `calls.call` edge with `candidates`. Several functions in the project may have the same name, and only one of them may be linked into the caller's binary. The core narrows those candidates after the resolvers have run (`narrowByBuildGraph` in `packages/core/indexer/src/narrow.ts`).

Narrowing only drops free functions. A **method** is never dropped, because virtual dispatch can reach any override, including a sibling implementation that the caller's binary links. A candidate is a method when either:

- its parent chain reaches a `structure.type` before the file, or
- its qualified name is `<prefix>::<name>`, where the last segment of `<prefix>` names a `structure.type` in the project. This covers out-of-line definitions such as `int Circle::area() {...}` in a `.cc` file, which the C++ frontend parents to the file rather than to the type.

The call edges carry no receiver flag, so a member call is not detected separately.

For each build system that owns both the caller's file and a candidate's file, a free-function candidate is handled as follows:

- The candidate is **kept** when one of the caller's owning targets reaches a target that owns the candidate (through `dep-edge`s), or when the caller's closure is **open**.
- The candidate is **dropped** only when at least one shared build system says it is not linked and none says it is linked.
- A candidate with no shared build system is kept.

The **open closure** rule: when a target in the caller's closure has an unresolved dependency, its closure is incomplete. Then no candidate is dropped on the basis of that closure, because the missing dependency may link it.

Narrowing never invents an edge and never drops every candidate. When one candidate is left, the edge becomes a plain target. An edge that was `heuristic` becomes `inferred`, and its `resolvedBy` gains `+build-graph`. The run summary reports `linker: narrowed N calls by build graph`. The indexer option `narrowByBuildGraph: false` turns this off.

## Dependencies lens: build-graph rules

The Dependencies lens checks the build graph when the project has build targets (`buildGraphRules` in `packages/lens/dependencies/src/build-graph.ts`). A project without build targets gets no extra findings, metrics or table.

| Rule | Finding | Severity | Fires when | Skipped when |
|---|---|---|---|---|
| `undeclared` | An include of a file or external package | warning | The two files are owned by targets of a common build system, and no target in the including file's dependency closure owns the included file (or, for an external, depends on it) | The closure is open (an unresolved dependency), or no build system owns both files |
| `unused` (target) | A declared target dependency | info | No include from the dependent target's files reaches a file of the dependency, and no call from its files reaches a function in it | The dependency has no header file (it is used only by linking). The dependency defines `main()` and the dependent target does not |
| `unused` (external) | A declared external dependency | info | No include from the target's files resolves to the external package | No include in the project resolves to that external at all |
| `visibility` | A dependency on a target with `visibility` | error | No entry of the target's `visibility` admits the dependent package (`//visibility:private` or an empty list admit none) | An entry is unreadable (for example a `package_group` label). A readable `//visibility:public` admits everyone. A target with no `visibility` is never checked |

Each rule reports one row in the "Build-graph dependency rules" table, with columns Rule, From, To and Detail. The metrics are `undeclaredDependencies`, `unusedDependencies` and `visibilityViolations`.

The three rules are on by default. Turn one off in the lens settings file, `.insight/lenses/lens-dependencies.json`:

```json
{ "buildGraph": { "undeclared": false, "unused": true, "visibility": true } }
```

Each switch is on unless it is `false`.

## Aliases for well-known packages

Include paths name well-known packages by their own prefix: `absl/…` is abseil, `gtest/…` and `gmock/…` are googletest, `benchmark/…` is google benchmark, and so on. The table is `CPP_INCLUDE_ALIAS_NAMES` in `packages/core/sdk/src/cpp.ts`, shared by the Bazel and CMake resolvers. An alias matches an external whose name is one of the aliased names. Without an alias, the path's first segment matches an external's name or Bazel `repo_name`. Boost also matches `boost.*` names.

## In the web app

The Arch view draws Bazel and CMake packages, their external packages, the declared dependencies between packages, and the build-graph arrows. See [arch-view.md](arch-view.md#build-packages-and-external-packages).

## Limits

- **No tool mode.** Neither frontend runs `bazel`, `cmake` or `make`. Facts come from the files, so a macro, a generated file or a computed list can be missing or approximate.
- **Bazel macros and select().** Macros are heuristic targets. `select()` takes every branch. Repositories declared in a `.bzl` macro are not seen, and `copts`, `defines` and toolchains are not read.
- **CMake conditions.** Platform and `if()` conditions are not evaluated, so a target that exists on one platform only is read as present on every platform.
- **Open closures.** Any unresolved dependency leaves the closure open, so the lens and narrowing say less about that target.
- **Re-index cost.** A re-index of an unchanged large repository still re-runs the link and the analysis. In the P0 probe, abseil-cpp (8b0c424, about 260 library and 258 test targets) took 148 s with no file extracted. The cost is in link and analysis, not in reading the BUILD files.
- **Scope.** C++ semantic precision that has nothing to do with the build (overloads, templates, method calls on objects) is out of scope.

## Adding another build system

A new build-system frontend fills the same contract. It does not change the core. The plan for each system is below. **None of these is built yet.**

| Build system | Plan | Status |
|---|---|---|
| Ninja (`build.ninja`, usually generated by CMake, GN or Meson) | A static parse is exact. Link statements become targets (their output comes from the rule). Compile edges `.o ← .cc` give membership. A linked `.a` or `.so` gives a dependency. A package is the source directory of a target's files | Not built |
| Make | Static Makefile parsing is unreliable (variables, pattern rules, recursion). Tool mode (`make -pn`, or `bear` to write `compile_commands.json`) gives targets and per-file include directories. A package is the directory of the Makefile that links a target | Not built |
| Meson | Meson generates `build.ninja`, so the Ninja route applies. Its own introspection output is another option | Not designed |
| `compile_commands.json` | No targets or packages. It gives per-file `-I` directories for an exact `cpp.include` resolver (`fallback` unset). It pairs with any of the above | Not built |

Each new frontend sets `buildSystem` and `manager` to its own name, and makes the node ids of its packages and targets scoped (`cmake:…`, `//…`), so two build systems can describe the same directory without a clash.
