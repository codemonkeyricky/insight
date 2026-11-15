// The Detail choice of the flow map, per reader: "coupling" draws the coupling chart of each function (its rows that cross
// a module, do I/O, spawn work or throw out), "all" draws the full control-flow chart. It lives in localStorage, and storage
// can be blocked, so every access is guarded: a blocked or missing store means the default, coupling.
export const DETAIL_KEY = "insight.flow.detail";

export type FlowDetail = "coupling" | "all";

export function readDetail(): FlowDetail {
  try {
    return globalThis.localStorage?.getItem(DETAIL_KEY) === "all" ? "all" : "coupling";
  } catch {
    return "coupling";
  }
}

export function writeDetail(detail: FlowDetail): void {
  try {
    globalThis.localStorage?.setItem(DETAIL_KEY, detail);
  } catch {
    // Storage is blocked: the choice lasts for this view only.
  }
}
