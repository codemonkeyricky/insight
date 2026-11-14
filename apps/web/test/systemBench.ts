import type { SystemModel, SystemSlice, SystemEdge, SystemResource, SystemRuntime } from "@insight/model";
import { createHash } from "node:crypto";
import type { SysLayout } from "../src/arch/system-layout";

/** A deterministic synthetic grounded model: `comps` components over a few processes, threads and coroutines, `edges` edges. */
export function synthModel(comps: number, edges: number): SystemModel {
  let seed = 12345;
  const rnd = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const procs = Math.max(2, Math.round(comps / 25));
  const runtimes: SystemRuntime[] = [];
  const holders: string[] = [];
  for (let p = 0; p < procs; p++) {
    runtimes.push({ id: `program:p${p}`, kind: "program", label: `p${p} · Node`, programKind: "node", spawn: { file: `p${p}/main.ts`, line: 1, status: "resolved" } });
    holders.push(`program:p${p}`);
    for (let t = 0; t < 2; t++) {
      runtimes.push({ id: `thread:p${p}t${t}`, kind: "thread", label: `T${t}`, parent: `program:p${p}` });
      holders.push(`thread:p${p}t${t}`);
      for (let c = 0; c < 2; c++) runtimes.push({ id: `coroutine:p${p}t${t}c${c}`, kind: "coroutine", label: `co${c}`, parent: `thread:p${p}t${t}` });
    }
  }
  const compIds = Array.from({ length: comps }, (_, i) => `c${i}`);
  const slices: SystemSlice[] = [];
  const sliceIds: string[] = [];
  compIds.forEach((c, i) => {
    const rts = [holders[i % holders.length] as string, holders[(i * 7 + 3) % holders.length] as string];
    for (const rt of new Set(rts)) {
      slices.push({ id: `${rt}|${c}`, runtime: rt, component: c, functions: 1 + (i % 5), root: i % 11 === 0 });
      sliceIds.push(`${rt}|${c}`);
    }
  });
  const resources: SystemResource[] = [
    ...Array.from({ length: procs }, (_, p): SystemResource => ({ id: `queue:p${p}`, kind: "queue", label: `q${p}`, program: `program:p${p}`, source: "message" })),
    { id: "os:signal", kind: "os", label: "Signals", source: "os" },
    { id: "os:fs", kind: "os", label: "Files", source: "os" },
  ];
  const externals = Array.from({ length: 12 }, (_, i) => ({ id: `ext${i}`, label: `Ext ${i}`, category: (["filesystem", "service", "network", "database"] as const)[i % 4] as "filesystem" }));
  const verbs = ["calls", "reads", "writes", "requests"] as const;
  const es: SystemEdge[] = [];
  for (let i = 0; i < edges; i++) {
    const from = sliceIds[rnd(sliceIds.length)] as string;
    const r = rnd(10);
    const to = r < 4 ? (sliceIds[rnd(sliceIds.length)] as string) : r < 7 ? `ext${rnd(externals.length)}` : r < 8 ? `queue:p${rnd(procs)}` : r < 9 ? "os:signal" : "os:fs";
    const verb = verbs[rnd(4)] as SystemEdge["verb"];
    es.push({
      id: `e${i}`, from, to, verb, label: `${verb}${rnd(6)}`, count: 1 + rnd(4),
      sites: [{ file: "x.ts", line: 1 }], confidence: i % 7 === 0 ? "inferred" : "exact",
      ...(to.startsWith("ext") ? { evidence: [{ api: `api${rnd(8)}`, level: "api" as const, count: 1 }] } : {}),
    });
  }
  return {
    scope: "",
    runtime: "grounded",
    components: compIds.map((id) => ({ id, label: id, path: id, kind: "folder" as const, files: 1, functions: 3, entry: false })),
    routes: [],
    externals,
    edges: es,
    stages: [compIds.slice(0, comps / 3 | 0), compIds.slice(comps / 3 | 0, 2 * comps / 3 | 0), compIds.slice(2 * comps / 3 | 0)],
    runtimes,
    slices,
    resources,
  };
}

/** A short hash of a layout's full JSON, to prove the output did not change. */
export const hashOf = (l: SysLayout): string => createHash("sha1").update(JSON.stringify(l)).digest("hex").slice(0, 12);
