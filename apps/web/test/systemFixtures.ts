import type { SystemEdge, SystemExternal, SystemModel, SystemResource, SystemRuntime, SystemSlice } from "@insight/model";

export const site = { file: "svc/src/a.ts", line: 3 };
export const slice = (rt: string, comp: string, functions = 2, extra: Partial<SystemSlice> = {}): SystemSlice => ({ id: `${rt}|${comp}`, runtime: rt, component: comp, functions, root: false, ...extra });
export const ext = (id: string, label: string, category: SystemExternal["category"]): SystemExternal => ({ id, label, category });
export const edge = (from: string, to: string, verb: SystemEdge["verb"], label: string, evidence?: SystemEdge["evidence"]): SystemEdge => ({
  id: `${from}>${verb}>${to}`,
  from,
  to,
  verb,
  label,
  count: 1,
  sites: [site],
  confidence: "exact",
  ...(evidence !== undefined ? { evidence } : {}),
});

export const PA = "program:svc"; // a grounded process with a worker thread and a coroutine
export const PB = "program:other"; // a process whose only thread is implicit
export const TW = "thread:worker";
export const TI = "thread:other-main";
export const CO = "coroutine:worker:run";
export const runtimes: SystemRuntime[] = [
  { id: PA, kind: "program", label: "svc · Node", programKind: "node", spawn: { file: "svc/src/main.ts", line: 1, status: "resolved" } },
  { id: TW, kind: "thread", label: "Worker · w.ts", parent: PA },
  { id: CO, kind: "coroutine", label: "run", parent: TW },
  { id: PB, kind: "program", label: "other · Node", programKind: "node", spawn: { file: "svc/src/a.ts", line: 3, api: "child_process.fork", status: "resolved" } },
  { id: TI, kind: "thread", label: "Main thread", parent: PB, implicit: true },
  { id: "unthreaded", kind: "unthreaded", label: "Not on a thread" },
];
export const A = "A";
export const B = "B";
export const C = "C";
export const resources: SystemResource[] = [
  { id: `queue:${PA}:inbox`, kind: "queue", label: "inbox", program: PA, source: "message" },
  { id: `lock:${PA}:m`, kind: "lock", label: "mutex m_", program: PA, source: "sync" },
  { id: `env:${PA}`, kind: "env", label: "Environment", program: PA, source: "env", names: ["PORT"] },
  { id: "os:signal", kind: "os", label: "Signals", source: "os" },
];

export function model(): SystemModel {
  const slices: SystemSlice[] = [
    slice(PA, A, 3, { root: true }),
    slice(PA, B, 1),
    slice(TW, B, 4, { root: true, awaits: 2 }),
    slice(CO, C, 1, { root: true }),
    slice(TI, A, 5, { root: true }),
  ];
  const ev = [{ api: "openat", syscall: "openat", level: "syscall" as const, count: 2 }];
  return {
    scope: "svc",
    runtime: "grounded",
    components: [A, B, C].map((id) => ({ id, label: `svc/${id}`, path: `svc/${id}`, kind: "folder" as const, files: 1, functions: 3, entry: false })),
    routes: [],
    externals: [ext("fs", "Filesystem", "filesystem"), ext("github", "GitHub API", "service"), ext("config", "Config", "config")],
    edges: [
      edge(`${PA}|${A}`, `${TW}|${B}`, "calls", "calls"),
      edge(`${PA}|${A}`, `queue:${PA}:inbox`, "enqueues", "message"),
      edge(`queue:${PA}:inbox`, `${TW}|${B}`, "dequeues", "message"),
      edge(`${PA}|${A}`, `lock:${PA}:m`, "locks", "acquire"),
      edge(`${PA}|${A}`, `env:${PA}`, "reads", "1 var"),
      edge(`${PA}|${A}`, "fs", "reads", "openat ×2", ev),
      edge(`${TW}|${B}`, "fs", "reads", "fs.readFile", [{ api: "fs.readFile", level: "api", count: 1 }]),
      edge(`${TW}|${B}`, "github", "requests", "GET"),
      edge(`${PA}|${A}`, PB, "spawns", "spawns fork"),
      edge(`${PA}|${A}`, "os:signal", "signals", "SIGTERM"),
      edge(`${CO}`.replace(CO, `${CO}|${C}`), "github", "requests", "GET"),
    ],
    stages: [[A], [B], [C]],
    runtimes,
    slices,
    resources,
  };
}
