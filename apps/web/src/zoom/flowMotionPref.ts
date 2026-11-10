// The Flow motion choice of the flow map, per reader (on by default). It lives in localStorage, and storage can be blocked,
// so every access is guarded: a blocked store means the choice lasts for the view only. Same pattern as lambdaPref.ts.
export const FLOW_MOTION_KEY = "insight.flow.motion";

export function readFlowMotion(): boolean {
  try {
    return globalThis.localStorage?.getItem(FLOW_MOTION_KEY) !== "0";
  } catch {
    return true;
  }
}

export function writeFlowMotion(on: boolean): void {
  try {
    globalThis.localStorage?.setItem(FLOW_MOTION_KEY, on ? "1" : "0");
  } catch {
    // Storage is blocked: the choice lasts for this view only.
  }
}
