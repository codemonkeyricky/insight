// The Runtime boxes choice of the flow map's roots-only view, per reader (on by default). When on, the roots sit in their
// thread boxes inside their process boxes. It lives in localStorage, and storage can be blocked, so every access is
// guarded: a blocked store means the choice lasts for the view only. Same pattern as flowMotionPref.ts.
export const RUNTIME_KEY = "insight.flow.runtime";

export function readRuntimeBoxes(): boolean {
  try {
    return globalThis.localStorage?.getItem(RUNTIME_KEY) !== "0";
  } catch {
    return true;
  }
}

export function writeRuntimeBoxes(on: boolean): void {
  try {
    globalThis.localStorage?.setItem(RUNTIME_KEY, on ? "1" : "0");
  } catch {
    // Storage is blocked: the choice lasts for this view only.
  }
}
