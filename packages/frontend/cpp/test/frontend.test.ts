import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type IRNode, type IRRecord } from "@insight/ir";
import { createCoreRegistry } from "@insight/ir/node";
import { runFrontendConformance, type IRBatch, type ProjectRoot } from "@insight/sdk";
import frontend from "../src/index.js";
import { blankAttrMacros, discoverAttrMacros } from "../src/macros.js";
import { blankClassHeadMacros } from "../src/project.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "sample-cpp");
const goldenFile = join(here, "golden", "sample-cpp.ndjson");
const kindsFile = join(here, "..", "data", "kinds.json");
const files = [
  "src/broken.cc",
  "src/main.cc",
  "src/os.cc",
  "src/queues.cc",
  "src/queues.h",
  "src/signals.cc",
  "src/store.cc",
  "src/store.h",
  "src/sync.cc",
  "src/util/log.h",
];

const root: ProjectRoot = { path: fixtureRoot, name: "sample-cpp", allowBuildTools: false };
const readFile = async (rel: string) => readFileSync(join(fixtureRoot, rel), "utf8");

function registry() {
  const reg = createCoreRegistry();
  reg.add(JSON.parse(readFileSync(kindsFile, "utf8")) as unknown[], "frontend-cpp");
  return reg;
}

async function extractAll(): Promise<IRBatch[]> {
  const batches: IRBatch[] = [];
  const ctx = { root, files, listFiles: () => [...files], readFile, log: () => undefined };
  for await (const batch of frontend.extract(ctx)) batches.push(batch);
  return batches;
}

const allRecords = (batches: IRBatch[]): IRRecord[] => batches.flatMap((b) => b.records);

/** One sorted line per record, so the golden file diffs cleanly. */
function toGolden(batches: IRBatch[]): string {
  return allRecords(batches).map((r) => JSON.stringify(r)).sort().join("\n") + "\n";
}

describe("frontend-cpp", () => {
  it("passes the SDK conformance kit", async () => {
    const report = await runFrontendConformance({ frontend, root, files, readFile, registry: registry() });
    const failed = report.checks.filter((c) => !c.ok);
    expect(failed).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("detects a project with C or C++ sources", async () => {
    expect(await frontend.detect(root)).not.toBeNull();
    expect(await frontend.detect({ path: join(here, "..", "data"), name: "x", allowBuildTools: false })).toBeNull();
  });

  it("emits the structure, calls, flow, effects, and sync facts the sample holds", async () => {
    const records = allRecords(await extractAll());
    const nodes = records.flatMap((r) => ("node" in r ? [r.node] : []));
    const edges = records.flatMap((r) => ("edge" in r ? [r.edge] : []));
    const kinds = (k: string) => nodes.filter((n) => n.kind === k);
    expect(kinds("structure.function").map((n) => n.id)).toEqual(
      expect.arrayContaining(["src/store.cc#app::Store::put", "src/store.cc#app::Store::get", "src/store.cc#app::Store::flush", "src/main.cc#main"]),
    );
    expect(kinds("structure.type").map((n) => n.attrs.name)).toEqual(expect.arrayContaining(["Store"]));
    expect(kinds("flow.throw")).toHaveLength(1);
    expect(kinds("flow.loop").map((n) => n.attrs.variant)).toEqual(["for"]);
    expect(kinds("effects.env.read").map((n) => n.attrs.api)).toEqual(["std::getenv"]);
    expect(kinds("effects.clock.read")).toHaveLength(1);
    expect(kinds("concurrency.spawn-thread").map((n) => n.attrs.target)).toEqual(["log_line"]);
    // The other fixtures take locks too, so these checks read store.cc only.
    const inStore = (n: IRNode) => n.id.startsWith("src/store.cc@");
    expect(kinds("x-cpp.scoped-lock").filter(inStore).map((n) => n.attrs.lock)).toEqual(["app::Store::mu_", "app::Store::mu_"]);
    expect(kinds("sync.lock-release").filter(inStore)).toHaveLength(3);
    expect(kinds("sync.lock-acquire").map((n) => n.attrs.lock)).toEqual(["app::Store::mu_"]);
    const includes = edges.filter((e) => e.kind === "packaging.include");
    expect(includes.some((e) => typeof e.to === "object" && "unresolved" in e.to && e.to.unresolved.text === "util/log.h")).toBe(true);
    const calls = edges.filter((e) => e.kind === "calls.call");
    expect(calls.some((e) => e.from === "src/main.cc#main" && e.to === "src/store.cc#app::Store::put")).toBe(true);
  });

  it("gives a file with parse errors inferred facts and a warning", async () => {
    const records = allRecords(await extractAll());
    const warning = records.find((r) => "finding" in r && r.finding.span?.file === "src/broken.cc");
    expect(warning && "finding" in warning ? warning.finding.severity : undefined).toBe("warning");
    // Error recovery can drop declarations after the error, so only the earlier function is checked.
    const first = records.find((r) => "node" in r && r.node.id === "src/broken.cc#first");
    expect(first && "node" in first ? first.node.provenance.confidence : undefined).toBe("inferred");
  });

  it("matches the golden IR for the sample project", async () => {
    const actual = toGolden(await extractAll());
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(goldenFile, actual);
    expect(actual).toBe(readFileSync(goldenFile, "utf8"));
  });
});

describe("frontend-cpp out-of-line class template methods", () => {
  it("names template <class T> void Foo<T>::bar() as Foo::bar, without template arguments", async () => {
    const src = "template <class T>\nclass Foo {\n public:\n  void bar();\n};\n\ntemplate <class T>\nvoid Foo<T>::bar() {}\n";
    const file = "tpl/foo.cc";
    const ctx = { root, files: [file], listFiles: () => [file], readFile: async () => src, log: () => undefined };
    const batches: IRBatch[] = [];
    for await (const batch of frontend.extract(ctx)) batches.push(batch);
    const fns = allRecords(batches).flatMap((r) => ("node" in r && r.node.kind === "structure.function" ? [r.node] : []));
    const bar = fns.find((n) => n.id === `${file}#Foo::bar`);
    expect(bar?.attrs.name).toBe("bar");
    expect(bar?.attrs.qualifiedName).toBe("Foo::bar");
  });
});

describe("frontend-cpp declared names", () => {
  const extractSource = async (file: string, src: string): Promise<IRBatch[]> => {
    const ctx = { root, files: [file], listFiles: () => [file], readFile: async () => src, log: () => undefined };
    const batches: IRBatch[] = [];
    for await (const batch of frontend.extract(ctx)) batches.push(batch);
    return batches;
  };
  const functionsOf = (batches: IRBatch[]) =>
    allRecords(batches).flatMap((r) => ("node" in r && r.node.kind === "structure.function" ? [r.node] : []));

  const rows: [string, string, string, string][] = [
    ["macro before a std return type", "BENCHMARK_EXPORT std::map<std::string, std::string> KvPairsFromEnv(const char* f, int x) { return {}; }", "KvPairsFromEnv", "KvPairsFromEnv"],
    ["macro before a qualified out-of-line method", "struct Foo { std::vector<int> Bar(); };\nABSL_MUST_USE_RESULT std::vector<int> Foo::Bar() { return {}; }", "Bar", "Foo::Bar"],
    ["macro before absl::Status", "ABSL_ATTRIBUTE_NOINLINE absl::Status Check(int v) { return {}; }", "Check", "Check"],
    ["template class method with a template argument", "template <class T> void Foo<T>::bar() {}", "bar", "Foo::bar"],
    ["template argument with a parenthesized comparison", "template <int N> void Arr<(N > 2)>::put() {}", "put", "Arr::put"],
    ["enable_if return type with <=", "template <class Tp> inline typename std::enable_if<sizeof(Tp) <= sizeof(Tp*)>::type DoNotOptimize(Tp const& v) {}", "DoNotOptimize", "DoNotOptimize"],
    ["nested template arguments", "template <class T> void Foo<Bar<T>>::baz() {}", "baz", "Foo::baz"],
    ["operator<", "bool operator<(const A&, const A&) { return false; }", "operator<", "operator<"],
    ["operator<<", "std::ostream& operator<<(std::ostream& o, const A&) { return o; }", "operator<<", "operator<<"],
    ["out-of-line operator<=>", "auto A::operator<=>(const A&) const {}", "operator<=>", "A::operator<=>"],
  ];

  it.each(rows)("names %s", async (_label, src, simple, qualified) => {
    const file = `names/${simple.replace(/\W/g, "_")}.cc`;
    const fns = functionsOf(await extractSource(file, src));
    const fn = fns.find((n) => n.attrs.name === simple);
    expect(fn?.attrs.name).toBe(simple);
    expect(fn?.attrs.qualifiedName).toBe(qualified);
  });

  it("resolves a call to a function whose return type sits behind a macro", async () => {
    const file = "names/env.cc";
    const src = "BENCHMARK_EXPORT std::map<std::string, std::string> KvPairsFromEnv(const char* f, int x) { return {}; }\nvoid caller() { KvPairsFromEnv(\"x\", 1); }\n";
    const calls = allRecords(await extractSource(file, src)).flatMap((r) => ("edge" in r && r.edge.kind === "calls.call" ? [r.edge] : []));
    expect(calls.some((e) => e.from === `${file}#caller` && e.to === `${file}#KvPairsFromEnv`)).toBe(true);
  });
});

describe("frontend-cpp round-4 fixes", () => {
  const extractOne = async (file: string, src: string): Promise<IRRecord[]> => {
    const ctx = { root, files: [file], listFiles: () => [file], readFile: async () => src, log: () => undefined };
    const batches: IRBatch[] = [];
    for await (const batch of frontend.extract(ctx)) batches.push(batch);
    return allRecords(batches);
  };
  const fnNodes = (records: IRRecord[]) => records.flatMap((r) => ("node" in r && r.node.kind === "structure.function" ? [r.node] : []));
  const callEdges = (records: IRRecord[]) => records.flatMap((r) => ("edge" in r && r.edge.kind === "calls.call" ? [r.edge] : []));

  it("keeps a call to overloads that share one qualified name, with every candidate", async () => {
    const types = ["int", "long", "short", "char", "bool", "float", "double", "unsigned", "long long", "unsigned char"];
    const overloads = types.map((t) => `void f(${t} x) {}`).join("\n");
    const file = "overload/ten.cc";
    const edges = callEdges(await extractOne(file, `${overloads}\nvoid caller() { f(1); }\n`));
    const call = edges.find((e) => e.from === `${file}#caller`);
    expect(call).toBeDefined();
    expect(typeof call?.to === "object" && "candidates" in call.to ? call.to.candidates.length : 0).toBe(10);
  });

  it("still caps a call to ten different functions that share a simple name", async () => {
    const namespaces = Array.from({ length: 10 }, (_, i) => `namespace n${i} { void f() {} }`).join("\n");
    const file = "overload/capped.cc";
    const edges = callEdges(await extractOne(file, `${namespaces}\nvoid caller() { f(); }\n`));
    expect(edges.some((e) => e.from === `${file}#caller`)).toBe(false);
  });

  it("resolves a call to an explicit operator new", async () => {
    const file = "ops/new.cc";
    const src = "void* operator new(std::size_t n) { return nullptr; }\nvoid caller() { void* p = operator new(8); }\n";
    const records = await extractOne(file, src);
    const target = `${file}#operator new`;
    expect(fnNodes(records).some((n) => n.id === target && n.attrs.name === "operator new")).toBe(true);
    expect(callEdges(records).some((e) => e.from === `${file}#caller` && e.to === target)).toBe(true);
  });

  it("gives a function declared = delete no function node", async () => {
    const records = await extractOne("del/a.cc", "struct A { A& operator=(const A&) = delete; };\n");
    expect(fnNodes(records).some((n) => n.attrs.name === "operator=")).toBe(false);
  });

  it("names a method of a class with an export macro under the real class", async () => {
    const records = await extractOne("macro/counter.cc", "namespace benchmark { class BENCHMARK_EXPORT Counter { public: int name() const { return 0; } }; }\n");
    const fn = fnNodes(records).find((n) => n.attrs.name === "name");
    expect(fn?.attrs.qualifiedName).toBe("benchmark::Counter::name");
  });

  it("names a method of a struct with an export macro under the real struct", async () => {
    const records = await extractOne("macro/struct.cc", "namespace benchmark { struct GTEST_API_ S { int name() const { return 0; } }; }\n");
    const fn = fnNodes(records).find((n) => n.attrs.name === "name");
    expect(fn?.attrs.qualifiedName).toBe("benchmark::S::name");
  });
});

describe("frontend-cpp class export macros and member candidates", () => {
  const extractFiles = async (sources: Record<string, string>): Promise<IRRecord[]> => {
    const names = Object.keys(sources);
    const ctx = { root, files: names, listFiles: () => names, readFile: async (f: string) => sources[f] ?? "", log: () => undefined };
    const batches: IRBatch[] = [];
    for await (const batch of frontend.extract(ctx)) batches.push(batch);
    return allRecords(batches);
  };
  const extractOne = (file: string, src: string) => extractFiles({ [file]: src });
  const fnNodes = (records: IRRecord[]) => records.flatMap((r) => ("node" in r && r.node.kind === "structure.function" ? [r.node] : []));
  const typeNodes = (records: IRRecord[]) => records.flatMap((r) => ("node" in r && r.node.kind === "structure.type" ? [r.node] : []));
  const callEdges = (records: IRRecord[]) => records.flatMap((r) => ("edge" in r && r.edge.kind === "calls.call" ? [r.edge] : []));

  it("names a macro class with an attribute macro and a real name as a type and its methods under it", async () => {
    const file = "macro/state.h";
    const src = "namespace benchmark { class BENCHMARK_EXPORT BENCHMARK_INTERNAL_CACHELINE_ALIGNED State { public: int range() const { return 0; } }; }\n";
    const records = await extractOne(file, src);
    expect(typeNodes(records).some((n) => n.id === `${file}#benchmark::State` && n.attrs.name === "State")).toBe(true);
    const range = fnNodes(records).find((n) => n.attrs.name === "range");
    expect(range?.attrs.qualifiedName).toBe("benchmark::State::range");
    expect(range?.id).toBe(`${file}#benchmark::State::range`);
  });

  it("keeps the real column of a method declared after a class-head macro", async () => {
    const file = "macro/span.h";
    const src = "namespace benchmark { class BENCHMARK_EXPORT BENCHMARK_INTERNAL_CACHELINE_ALIGNED State { public: int range() const { return 0; } }; }\n";
    const range = fnNodes(await extractOne(file, src)).find((n) => n.attrs.name === "range");
    expect(range?.span?.start).toEqual([0, src.indexOf("int range")]);
  });

  it("names a derived class with an export macro and a base clause", async () => {
    const file = "macro/derived.h";
    const src = "class EXP Base { public: virtual void f(); };\nclass EXP Derived : public Base { public: void f() override {} };\n";
    const records = await extractOne(file, src);
    expect(fnNodes(records).some((n) => n.id === `${file}#Derived::f`)).toBe(true);
    expect(typeNodes(records).some((n) => n.attrs.name === "Derived")).toBe(true);
  });

  it("names a method of a class with a final specifier, not the word final", async () => {
    const file = "macro/final.h";
    const records = await extractOne(file, "class API Q final { public: void g() {} };\n");
    expect(fnNodes(records).some((n) => n.id === `${file}#Q::g`)).toBe(true);
    expect(fnNodes(records).some((n) => n.id.endsWith("#final::g"))).toBe(false);
  });

  it("names a method of a struct with a macro suffix on its keyword", async () => {
    const file = "macro/gtest.h";
    const records = await extractOne(file, "struct GTEST_API_ S { void h() {} };\n");
    expect(fnNodes(records).some((n) => n.id === `${file}#S::h`)).toBe(true);
  });

  it("leaves a class whose one all-caps word is its name", async () => {
    const file = "macro/url.h";
    const records = await extractOne(file, "class URL { void p() {} };\n");
    expect(fnNodes(records).some((n) => n.id === `${file}#URL::p`)).toBe(true);
  });

  it("leaves an enum class alone", async () => {
    const file = "macro/enum.h";
    const records = await extractOne(file, "enum class COLOR { RED };\nvoid after() {}\n");
    expect(fnNodes(records).some((n) => n.id === `${file}#after`)).toBe(true);
    expect(typeNodes(records).some((n) => n.attrs.name === "COLOR" && n.attrs.typeKind === "enum")).toBe(true);
  });

  it("leaves a template type parameter alone", async () => {
    const file = "macro/template.h";
    const records = await extractOne(file, "template <class T> struct W { void w() {} };\n");
    expect(fnNodes(records).some((n) => n.id === `${file}#W::w`)).toBe(true);
  });

  it("resolves a member call to a method, not to the constructor of a class with the same name", async () => {
    const file = "ctor/member.cc";
    const src = "struct Arg { Arg(int) {} };\nstruct B { B* Arg(int) { return this; } };\nvoid t(B* b) { b->Arg(1); }\n";
    const edges = callEdges(await extractOne(file, src));
    const call = edges.find((e) => e.from === `${file}#t`);
    expect(call).toBeDefined();
    const targets = typeof call?.to === "object" && "candidates" in call.to ? call.to.candidates : [call?.to];
    expect(targets).toEqual([`${file}#B::Arg`]);
  });

  it("keeps a call to an overload set in one file, with every candidate", async () => {
    const types = ["int", "long", "short", "char", "bool", "float", "double", "unsigned", "long long", "unsigned char"];
    const file = "cap/same-file.cc";
    const overloads = types.map((t) => `void f(${t} x) {}`).join("\n");
    const edges = callEdges(await extractOne(file, `${overloads}\nvoid caller() { f(1); }\n`));
    const call = edges.find((e) => e.from === `${file}#caller`);
    expect(typeof call?.to === "object" && "candidates" in call.to ? call.to.candidates.length : 0).toBe(10);
  });

  it("caps a same-named function defined in different files, but keeps the same overloads in one file", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) files[`cap/f${i}.cc`] = `void f(int a, int b${i}) {}\n`;
    files["cap/caller.cc"] = "void caller() { f(1, 2); }\n";
    expect(callEdges(await extractFiles(files)).some((e) => e.from === "cap/caller.cc#caller")).toBe(false);
    // Control: the same ten overloads in one file are kept, so the drop above comes from the cross-file cap.
    const same: Record<string, string> = { "cap/same.cc": `${Array.from({ length: 10 }, (_, i) => `void f(int a, int b${i}) {}`).join("\n")}\nvoid caller() { f(1, 2); }\n` };
    expect(callEdges(await extractFiles(same)).some((e) => e.from === "cap/same.cc#caller")).toBe(true);
  });
});

describe("frontend-cpp define-driven attribute macros", () => {
  const run = async (sources: Record<string, string>): Promise<IRBatch[]> => {
    const names = Object.keys(sources);
    const ctx = { root, files: names, listFiles: () => names, readFile: async (f: string) => sources[f] ?? "", log: () => undefined };
    const batches: IRBatch[] = [];
    for await (const batch of frontend.extract(ctx)) batches.push(batch);
    return batches;
  };
  const qnames = (batches: IRBatch[]) =>
    allRecords(batches).flatMap((r) => ("node" in r && r.node.kind === "structure.function" ? [String(r.node.attrs.qualifiedName)] : []));
  const macrosOf = (src: string) => discoverAttrMacros(new Map([["m.h", src]]));

  it("scopes an out-of-line method of a class with a defined export macro and an attribute", async () => {
    const src = '#define EXP __attribute__((visibility("default")))\nclass EXP [[nodiscard]] Foo { public: int bar(); };\nint Foo::bar(){return 1;}\n';
    expect(qnames(await run({ "a.h": src }))).toContain("Foo::bar");
  });

  it("uses the class-head fallback for two macros defined outside the project", async () => {
    const src = "class OUTSIDE_API OTHER_EXPORT Foo { public: int bar() { return 1; } };\n";
    expect(qnames(await run({ "a.h": src }))).toContain("Foo::bar");
  });

  it("names a method with a trailing annotation macro", async () => {
    const src = "#define LOCK(x) __attribute__((acquire_capability(x)))\nclass S { int mu; public: void lock() LOCK(mu) {} };\n";
    const names = qnames(await run({ "a.h": src }));
    expect(names).toContain("S::lock");
    expect(names.some((n) => n.includes("LOCK"))).toBe(false);
  });

  it("keeps a class intact when a member has an empty annotation macro", async () => {
    const src = "#define GUARDED(x)\nclass S { int v GUARDED(mu); public: void f() {} };\nvoid after() {}\n";
    const names = qnames(await run({ "a.h": src }));
    expect(names).toEqual(expect.arrayContaining(["S::f", "after"]));
  });

  it("keeps methods scoped when macros sit inside the class body", async () => {
    const src = [
      "#define CACHE_ALIGNED __attribute__((aligned(64)))",
      "#define NO_ALIAS __declspec(noalias)",
      "#define MUST_USE [[nodiscard]]",
      "namespace bm {",
      "class API CACHE_ALIGNED State {",
      " public:",
      "  MUST_USE bool KeepRunning();",
      "  NO_ALIAS void PauseTiming() {}",
      " private:",
      "  CACHE_ALIGNED int x_;",
      "};",
      "void Free() {}",
      "}",
    ].join("\n");
    const names = qnames(await run({ "state.h": src }));
    expect(names).toEqual(expect.arrayContaining(["bm::State::PauseTiming", "bm::Free"]));
  });

  it("does not blank a macro that is not attribute-like", () => {
    const macros = macrosOf("#define MYTYPE int\n#define MIXED_X __attribute__((a))\n#define MIXED_X static\n");
    expect(macros.has("MYTYPE")).toBe(false);
    expect(macros.has("MIXED_X")).toBe(false);
    expect(blankAttrMacros("MYTYPE f();", macros).text).toBe("MYTYPE f();");
  });

  it("resolves attribute macros that use other attribute macros", () => {
    const macros = macrosOf("#define A_ATTR __attribute__((x))\n#define B_ATTR A_ATTR inline\n#define C_ATTR static A_ATTR\n");
    expect([...macros.keys()].sort()).toEqual(["A_ATTR", "B_ATTR"]);
  });

  it("leaves comments, strings, raw strings and define lines alone and keeps length and lines", async () => {
    const macros = macrosOf("#define EXP __attribute__((x))\n");
    const src = '// EXP in comment\nconst char* s = "EXP"; /* EXP */\nconst char* r = R"x(EXP)x";\n#define USE EXP\nEXP void f() {}\n';
    const out = blankAttrMacros(src, macros).text;
    expect(out.length).toBe(src.length);
    expect(out.split("\n").length).toBe(src.split("\n").length);
    expect(out).toBe(src.replace("EXP void f", "    void f"));
  });

  it("keeps the line number of a function after blanking", async () => {
    const src = "#define EXP __attribute__((x))\nclass EXP Foo {\n public:\n  int bar() const EXP { return 0; }\n};\n";
    const fn = allRecords(await run({ "a.h": src })).flatMap((r) => ("node" in r && r.node.kind === "structure.function" ? [r.node] : []))[0];
    expect(fn?.span?.start[0]).toBe(3);
  });

  it("swallows nested macro arguments", async () => {
    const src = "#define FOO(a, b) __attribute__((x))\nclass S { void f() FOO((a), b) {} };\n";
    const names = qnames(await run({ "a.h": src }));
    expect(names).toEqual(["S::f"]);
    expect(blankAttrMacros("FOO((a),b) x", discoverAttrMacros(new Map([["m", "#define FOO(a, b)\n"]]))).text).toBe(" ".repeat(10) + " x");
  });

  it("handles alignas and a qualified name after an undefined export macro", async () => {
    expect(qnames(await run({ "a.h": "class EXP alignas(8) X { public: void f() {} };\n" }))).toContain("X::f");
    expect(qnames(await run({ "a.h": "class EXP Outer::Inner { public: void g() {} };\nvoid after() {}\n" }))).toEqual(expect.arrayContaining(["after"]));
    expect(blankClassHeadMacros("class EXP Outer::Inner {")).toBe("class     Outer::Inner {");
    expect(blankClassHeadMacros("class FOO : public Bar {")).toBe("class FOO : public Bar {");
    expect(blankClassHeadMacros("class EXP FOO(a(b)) X final {")).toBe("class " + " ".repeat(3 + 1 + 9 + 1) + "X final {");
  });

  it("lists the header that defines a used macro as a dependency", async () => {
    const batches = await run({ "attr.h": "#define EXP __attribute__((x))\n", "use.h": "class EXP Foo { public: void f() {} };\n", "other.h": "void g() {}\n" });
    const by = (f: string) => batches.find((b) => b.file === f);
    expect(by("use.h")?.dependsOn).toContain("attr.h");
    expect(by("other.h")?.dependsOn ?? []).not.toContain("attr.h");
  });
});
