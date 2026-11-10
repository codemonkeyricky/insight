const url = new URL("./verify/verify.worker.ts", import.meta.url);

export const byConst = new Worker(url, { type: "module" });
export const byUrl = new Worker(new URL("./verify/print.worker.ts", import.meta.url), { type: "module" });
export const byString = new Worker("./verify/print.worker.ts");
export const shared = new SharedWorker("./verify/verify.worker.ts");

export function spawnAt(path: string) {
  return new Worker(path);
}
