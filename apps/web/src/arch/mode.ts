// The Arch tab's two views and the one the reader last chose. The choice lives in localStorage, which can be blocked, so
// every access is guarded and the page works without it.
export type ArchMode = "system" | "packages";

export const ARCH_MODE_KEY = "insight-arch-mode";
export const ARCH_MODES: readonly ArchMode[] = ["system", "packages"];
export const ARCH_MODE_LABELS: Record<ArchMode, string> = { system: "System", packages: "Packages" };

type Store = Pick<Storage, "getItem" | "setItem">;

const defaultStore = (): Store | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

/** The saved mode, or "system" when none is saved or storage is blocked. */
export function readArchMode(store: Store | undefined = defaultStore()): ArchMode {
  try {
    const v = store?.getItem(ARCH_MODE_KEY);
    if (v === "system" || v === "packages") return v;
  } catch {
    // Storage blocked: fall through to the default.
  }
  return "system";
}

export function writeArchMode(mode: ArchMode, store: Store | undefined = defaultStore()): void {
  try {
    store?.setItem(ARCH_MODE_KEY, mode);
  } catch {
    // The choice still applies for this page view.
  }
}
