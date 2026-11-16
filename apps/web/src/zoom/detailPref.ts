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

// The inter-module focus of the flow map (flowFocus), per reader: "intermodule" draws each function's chart with only its
// calls to exported functions of other files, and no kernel or environment effects. It replaces the coupling Detail: the two
// are never applied together. "all" is the full chart, with the Detail choice as before. Default: intermodule. Storage is
// guarded like the Detail choice.
export const FLOW_FOCUS_KEY = "insight.flow.focus";

export type FlowFocus = "intermodule" | "all";

/**
 * The choice made while storage could not keep it. The store and the checkbox read the focus they start with from here, so
 * a remount (FlowView, Workspace) agrees with the store even when localStorage is blocked. Undefined while storage keeps it.
 */
let unsavedFocus: FlowFocus | undefined;

export function readFlowFocus(): FlowFocus {
  if (unsavedFocus !== undefined) return unsavedFocus;
  try {
    return globalThis.localStorage?.getItem(FLOW_FOCUS_KEY) === "all" ? "all" : "intermodule";
  } catch {
    return "intermodule";
  }
}

export function writeFlowFocus(focus: FlowFocus): void {
  try {
    if (!globalThis.localStorage) throw new Error("no storage");
    globalThis.localStorage.setItem(FLOW_FOCUS_KEY, focus);
    unsavedFocus = undefined;
  } catch {
    // Storage is blocked: the choice lasts for this session, in memory.
    unsavedFocus = focus;
  }
}
