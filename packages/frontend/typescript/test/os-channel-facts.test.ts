import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { ProjectRoot } from "@insight/sdk";
import frontend from "../src/index.js";
import { importBindings, matchCall } from "../src/effects.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "sample-ts");
const root: ProjectRoot = { path: fixtureRoot, name: "sample-ts", allowBuildTools: false };
const files = ["src/app/main.ts", "src/lib/channels.ts", "src/lib/io.ts", "src/lib/math.ts", "src/lib/os-effects.ts", "src/lib/proc.ts"];
const readFile = async (rel: string) => readFileSync(join(fixtureRoot, rel), "utf8");

interface Fact {
  id: string;
  facet: string;
  kind: string;
  parent?: string;
  attrs: Record<string, unknown>;
}

let facts: Fact[] | undefined;

/** Every node the fixture project emits. */
async function allFacts(): Promise<Fact[]> {
  if (facts) return facts;
  const ctx = { root, files, listFiles: () => [...files], readFile, log: () => undefined };
  const out: Fact[] = [];
  for await (const batch of frontend.extract(ctx)) {
    for (const record of batch.records) if ("node" in record) out.push(record.node as unknown as Fact);
  }
  facts = out;
  return out;
}

/** The new facts that sit directly under one function of a fixture file. */
async function under(fn: string, file = "src/lib/os-effects.ts"): Promise<Fact[]> {
  return (await allFacts()).filter((n) => n.parent === `${file}#${fn}`);
}

const effectsOf = (nodes: Fact[]) => nodes.filter((n) => n.facet === "effects" || n.facet === "sync" || n.kind.startsWith("concurrency.channel"));

describe("OS, channel and sync facts from the TypeScript frontend", () => {
  it("process.kill with a literal signal is an os signal with syscall kill", async () => {
    expect(await under("stopChild")).toEqual([
      expect.objectContaining({ kind: "effects.os.call", attrs: { api: "process.kill", op: "signal", syscall: "kill", target: "SIGINT" } }),
    ]);
  });

  it("process.kill without a signal argument targets SIGTERM", async () => {
    const [node] = await under("stopDefault");
    expect(node?.attrs).toEqual({ api: "process.kill", op: "signal", syscall: "kill", target: "SIGTERM" });
  });

  it("process.kill with a dynamic signal targets <dynamic>", async () => {
    const [node] = await under("stopDynamic");
    expect(node?.attrs.target).toBe("<dynamic>");
  });

  it("a local function named kill emits nothing", async () => {
    expect(effectsOf(await under("callLocalKill"))).toEqual([]);
  });

  it("process.on emits only for SIG names, and nothing for other or dynamic events", async () => {
    const nodes = effectsOf(await under("onSignals"));
    expect(nodes.map((n) => n.attrs)).toEqual([
      { api: "process.on", op: "signal", target: "SIGINT" },
      { api: "process.once", op: "signal", target: "SIGTERM" },
    ]);
  });

  it("a project class with a postMessage method emits no message or channel fact", async () => {
    expect(effectsOf(await under("ping"))).toEqual([]);
    expect((await allFacts()).filter((n) => n.kind === "effects.message.post" && n.parent === "src/lib/os-effects.ts#ping")).toEqual([]);
  });

  it("BroadcastChannel send and receive share the literal channel name", async () => {
    const all = await allFacts();
    const sends = all.filter((n) => n.kind === "concurrency.channel-send" && n.attrs.channel === "jobs");
    const recvs = all.filter((n) => n.kind === "concurrency.channel-recv" && n.attrs.channel === "jobs");
    expect(sends.map((n) => n.attrs.api)).toEqual(["BroadcastChannel.postMessage"]);
    expect(recvs.map((n) => n.attrs.api).sort()).toEqual(["BroadcastChannel.addEventListener", "BroadcastChannel.onmessage"]);
  });

  it("a BroadcastChannel named by a variable is dynamic", async () => {
    const [send] = await under("openNamed", "src/lib/channels.ts");
    expect(send).toMatchObject({ kind: "concurrency.channel-send", attrs: { channel: "<dynamic>", api: "BroadcastChannel.postMessage" } });
  });

  it("MessageChannel ports share the channel identified by where it is made", async () => {
    const pair = await under("pair", "src/lib/channels.ts");
    const sendPort = pair.find((n) => n.kind === "concurrency.channel-send");
    const recvPort = pair.find((n) => n.kind === "concurrency.channel-recv");
    expect(sendPort?.attrs.channel).toBe("MessageChannel@src/lib/channels.ts:26");
    expect(recvPort?.attrs.channel).toBe("MessageChannel@src/lib/channels.ts:26");
  });

  it("navigator.locks.request is a lock acquire on its literal name, or dynamic", async () => {
    const locks = (await under("lockWork", "src/lib/channels.ts")).filter((n) => n.kind === "sync.lock-acquire");
    expect(locks.map((n) => n.attrs)).toEqual([
      { api: "navigator.locks.request", lock: "cache" },
      { api: "navigator.locks.request", lock: "<dynamic>" },
    ]);
  });

  it("Atomics.wait is a condvar wait, and Atomics.notify a notify", async () => {
    const atomics = await under("atomics", "src/lib/channels.ts");
    expect(atomics.find((n) => n.attrs.api === "Atomics.wait")).toMatchObject({ kind: "sync.condvar", facet: "sync", attrs: { api: "Atomics.wait", op: "wait" } });
    expect(atomics.find((n) => n.attrs.api === "Atomics.notify")).toMatchObject({ kind: "sync.condvar", attrs: { api: "Atomics.notify", op: "notify" } });
    expect(atomics.find((n) => n.attrs.api === "Atomics.add")).toMatchObject({ kind: "sync.atomic-op", attrs: { api: "Atomics.add", op: "op" } });
  });

  it("one-to-one wrappers carry a syscall and high-level calls do not", async () => {
    const wrappers = (await under("plainWrappers")).map((n) => n.attrs);
    expect(wrappers).toContainEqual({ api: "fs.unlinkSync", path: "/tmp/stale", syscall: "unlink" });
    expect(wrappers).toContainEqual({ api: "fs.readFileSync", path: "/etc/hosts" });
  });
});

/** Every call in a snippet, matched against the catalog with the snippet's own imports. */
function matchAll(code: string) {
  const sf = ts.createSourceFile("snippet.ts", code, ts.ScriptTarget.ES2022, true);
  const imports = importBindings(sf);
  const out: unknown[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) out.push(matchCall(n, imports));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe("catalog matching", () => {
  it("matches a default-imported node:os call and a named import from os", () => {
    expect(matchAll(`import os from "node:os"; os.cpus();`)).toEqual([{ kind: "effects.os.call", attrs: { api: "os.cpus", op: "info" } }]);
    expect(matchAll(`import { hostname } from "os"; hostname();`)).toEqual([{ kind: "effects.os.call", attrs: { api: "os.hostname", op: "info" } }]);
  });

  it("a local function named kill matches nothing", () => {
    expect(matchAll(`function kill(pid: number) { return pid; } kill(1);`)).toEqual([undefined]);
  });

  it("a dynamic signal is <dynamic> and a SIG literal is its name", () => {
    expect(matchAll(`process.kill(1, sig); process.kill(1, "SIGHUP");`)).toEqual([
      { kind: "effects.os.call", attrs: { api: "process.kill", op: "signal", syscall: "kill", target: "<dynamic>" } },
      { kind: "effects.os.call", attrs: { api: "process.kill", op: "signal", syscall: "kill", target: "SIGHUP" } },
    ]);
  });

  it("process.on matches only a SIG literal", () => {
    expect(matchAll(`process.on("exit", f); process.on(name, f); process.on("SIGHUP", f);`)).toEqual([
      undefined,
      undefined,
      { kind: "effects.os.call", attrs: { api: "process.on", op: "signal", target: "SIGHUP" } },
    ]);
  });

  it("a syscall is set on thin wrappers only, and read keeps path dynamic", () => {
    expect(matchAll(`import fs from "fs"; fs.unlink("a", f); fs.readFile("a", f); fs.read(3, b, 0, 1, 0, f);`)).toEqual([
      { kind: "effects.fs.write", attrs: { api: "fs.unlink", path: "a", syscall: "unlink" } },
      { kind: "effects.fs.read", attrs: { api: "fs.readFile", path: "a" } },
      { kind: "effects.fs.read", attrs: { api: "fs.read", path: "<dynamic>", syscall: "read" } },
    ]);
  });

  it("navigator.locks.request and Atomics match through their globals", () => {
    expect(matchAll(`navigator.locks.request("x", f); Atomics.wait(a, 0, 0);`)).toEqual([
      { kind: "sync.lock-acquire", attrs: { api: "navigator.locks.request", lock: "x" } },
      { kind: "sync.condvar", attrs: { api: "Atomics.wait", op: "wait" } },
    ]);
  });
});
