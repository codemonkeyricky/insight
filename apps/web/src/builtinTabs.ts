// The built-in tab ids. This module has no imports, so scopeLenses.ts can load it directly under Node's type
// stripping (the capture script loads scopeLenses.ts that way, and Node cannot resolve an extensionless import).

/**
 * The tabs every project has. Any other tab id is a lens id. The Source and Findings tabs are gone: their old URLs
 * redirect to Overview (see redirectFor), and their links open the code pane instead.
 */
export const BUILTIN_TABS = ["overview", "flow", "system", "arch", "compare", "review"] as const;
