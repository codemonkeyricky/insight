# Samples

`benchmark/` is an unmodified copy of google/benchmark, pinned to commit
`bbee269af6e5e0705b77cf54104b2c8f6f9cab2d` (2026-11-06, "fix(json_reporter): escape C0 control
characters per RFC 8259 (#2299) (#2358)"). It is vendored with `git archive`, so it has no `.git`
directory. Its license is Apache-2.0 (`benchmark/LICENSE`, kept as shipped).

It is the C++ + Bazel sample for Insight. It also contains `BUILD.bazel` and `CMakeLists.txt`,
so the same copy tests the Bazel overlay and the CMake drop-in. Nothing in it was edited.

To refresh it, archive the same path from a newer upstream commit and update the hash above.

## Static-mode results on `benchmark/`

Measured with `node packages/cli/dist/cli.js index samples/benchmark --full --json` (static mode only;
`--allow-build-tools` was not used). The same numbers are pinned in
`packages/core/test/golden/benchmark-summary.json`.

- Packaging: Bazel gives 6 targets, 90 target-contains and 7 dep edges. CMake gives 4 targets, 23 contains and
  12 dep edges, and one of those targets is the unexpanded name `cmake://test:${name}` (a `foreach` loop
  variable the CMake parser does not evaluate). Include edges come from frontend-cpp (889).
- 225 files: 121 C/C++ (frontend-cpp), 4 Bazel BUILD files (frontend-bazel), 3 CMakeLists.txt (frontend-cmake).
  TypeScript is not detected.
- 47 of the 121 C/C++ files hit tree-sitter error recovery. Each one gets a "parse errors in N place(s)"
  finding, and facts from those spans are inferred. Coverage's `filesWithErrors` shows 0 for them
  because it counts only extraction failures.
- Lock usage is thin: 4 lock acquires, 5 releases, 1 scoped lock, 5 thread spawns. The lock-order lens
  finds 4 lock identities, 0 order pairs and 0 cycles. Benchmark's own `benchmark::Mutex` and `MutexLock`
  wrappers are not recognized, so the lens reports nothing on this sample. That is a limit of the
  frontend, not evidence the code is safe.
- The call lens reports 355 "unreachable" functions. With no configured entries, it starts from functions
  the frontend marks `exported`. Code reached only through callbacks, function pointers or other indirect
  calls shows as unreachable, so treat those findings as leads, not proof of dead code.

## `lock-order-fixture/`

Hand-written, not taken from any project, and labelled as such in its own comment. It exists only to
exercise the lock-order lens. `transfer()` takes `accounts_mu` then `audit_mu`; `reconcile()` takes them in
the opposite order, and both run on threads. The lens should report one `cycle:accounts_mu|audit_mu`
finding. `packages/core/test/lock-order-fixture.test.ts` checks that.
