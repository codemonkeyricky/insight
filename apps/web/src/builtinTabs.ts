// The built-in tab ids. This module has no imports, so scopeLenses.ts can load it directly under Node's type
// stripping (the capture script loads scopeLenses.ts that way, and Node cannot resolve an extensionless import).

/**
 * The tabs of the tab bar, in order: Flow, Symbols, System, Pipeline and Packages. Any other tab id is not a tab: the routes for the
 * retired tabs (Overview, Arch, Compare, Triage, Source, Findings and every lens) redirect (see redirectFor).
 */
export const BUILTIN_TABS = ["flow", "symbols", "system", "pipeline", "packages"] as const;
