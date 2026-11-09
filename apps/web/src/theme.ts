/**
 * The colour theme: "system" follows the OS, "light" and "dark" force one. Dark is the default.
 * The choice is kept in localStorage and set on <html data-theme> before first paint by the inline
 * script in index.html, which reads the same key. Storage can be blocked, so every access is guarded.
 */
export type ThemeChoice = "system" | "light" | "dark";

export const THEME_KEY = "insight-theme";
export const THEME_CHOICES: readonly ThemeChoice[] = ["system", "light", "dark"];

export function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "system" || v === "light" || v === "dark") return v;
  } catch {
    // Storage blocked or unavailable: fall through to the default.
  }
  return "dark";
}

export function writeTheme(choice: ThemeChoice): void {
  try {
    localStorage.setItem(THEME_KEY, choice);
  } catch {
    // The choice still applies for this page view.
  }
}

/** Fired on window after the theme changes, so every switch on the page shows the same choice. */
export const THEME_EVENT = "insight-theme-change";

export function applyTheme(choice: ThemeChoice): void {
  document.documentElement.dataset.theme = choice;
  window.dispatchEvent(new Event(THEME_EVENT));
}

/** A design token's current value on the root element, e.g. tokenValue("--ink") gives "#F5F5F7". */
export function tokenValue(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
