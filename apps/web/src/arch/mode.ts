// The Arch tab's two views and the one the reader last chose. System is a top-level tab of its own now, so it is not a mode
// here. The choice lives in localStorage, which can be blocked, so every access is guarded and the page works without it.
export type ArchMode = "pipeline" | "packages";

export const ARCH_MODE_KEY = "insight-arch-mode";
export const ARCH_MODES: readonly ArchMode[] = ["pipeline", "packages"];
export const ARCH_MODE_LABELS: Record<ArchMode, string> = { pipeline: "Pipeline", packages: "Packages" };

type Store = Pick<Storage, "getItem" | "setItem">;

const defaultStore = (): Store | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

/**
 * The saved mode, or "packages" when none is saved, storage is blocked, or the saved value is unknown. A saved "system" (from when
 * System was a mode here) reads as "packages".
 */
export function readArchMode(store: Store | undefined = defaultStore()): ArchMode {
  try {
    const v = store?.getItem(ARCH_MODE_KEY);
    if (v === "pipeline" || v === "packages") return v;
  } catch {
    // Storage blocked: fall through to the default.
  }
  return "packages";
}

export function writeArchMode(mode: ArchMode, store: Store | undefined = defaultStore()): void {
  try {
    store?.setItem(ARCH_MODE_KEY, mode);
  } catch {
    // The choice still applies for this page view.
  }
}
