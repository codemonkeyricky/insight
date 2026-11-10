// The Lambdas choice of the flow map, per reader. It lives in localStorage, and storage can be blocked, so every access is
// guarded: a blocked store means the choice lasts for the view only. Shared by the map's layers and the panels' lists.
export const LAMBDAS_KEY = "insight.flow.lambdas";

export function readLambdas(): boolean {
  try {
    return globalThis.localStorage?.getItem(LAMBDAS_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeLambdas(on: boolean): void {
  try {
    globalThis.localStorage?.setItem(LAMBDAS_KEY, on ? "1" : "0");
  } catch {
    // Storage is blocked: the choice lasts for this view only.
  }
}
