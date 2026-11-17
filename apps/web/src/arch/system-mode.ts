// The System tab's two views and the one the reader last chose. Tiers (frontend, backend, storage, external) is the default;
// Runtime is the traced view. The choice lives in localStorage, which can be blocked, so every access is guarded and the page
// works without it.

/** The part of localStorage the mode helpers use. */
export type Store = Pick<Storage, "getItem" | "setItem">;

/** localStorage, or undefined when the browser blocks it (reading the global itself can throw). */
export const defaultStore = (): Store | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

export type SystemMode = "tiers" | "runtime";

export const SYSTEM_MODE_KEY = "insight-system-mode";
export const SYSTEM_MODES: readonly SystemMode[] = ["tiers", "runtime"];
export const SYSTEM_MODE_LABELS: Record<SystemMode, string> = { tiers: "Tiers", runtime: "Runtime" };

/** The saved mode, or "tiers" when none is saved, storage is blocked, or the saved value is unknown. */
export function readSystemMode(store: Store | undefined = defaultStore()): SystemMode {
  try {
    const v = store?.getItem(SYSTEM_MODE_KEY);
    if (v === "tiers" || v === "runtime") return v;
  } catch {
    // Storage blocked: fall through to the default.
  }
  return "tiers";
}

export function writeSystemMode(mode: SystemMode, store: Store | undefined = defaultStore()): void {
  try {
    store?.setItem(SYSTEM_MODE_KEY, mode);
  } catch {
    // The choice still applies for this page view.
  }
}
