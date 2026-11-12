// The name a reader sees for a function on the map and in a chart. Display only: ids, URLs and the model keep the full name.
// A named function shows its name. Module-level code shows its file's base name without the last extension ("src/main.tsx"
// -> "main"). A folded handler shows its event ("verify.worker.ts · on message" -> "on message").

const MODULE_SUFFIX = "#(module)";
const TOP_LEVEL = " · top level";

/** The base name of a file without its last extension: "src/verify/slice.worker.ts" -> "slice.worker". */
export function stemOf(file: string): string {
  const base = file.slice(file.lastIndexOf("/") + 1);
  return base.replace(/\.[^.]+$/, "");
}

/**
 * The display name of a function: `name` is its label, `id` its IR id when known. A module entry's id ends in "#(module)"
 * and names its file before that; a file-level chart names its file in "<file> · top level".
 */
export function displayName(name: string, id?: string): string {
  let file: string | undefined;
  if (id !== undefined && id.endsWith(MODULE_SUFFIX)) file = id.slice(0, -MODULE_SUFFIX.length);
  else if (name.endsWith(TOP_LEVEL)) file = name.slice(0, -TOP_LEVEL.length);
  else if (name === "(module)" && id !== undefined && !id.includes("#")) file = id;
  if (file !== undefined && file !== "") return stemOf(file);
  const handler = / · (on .+)$/.exec(name);
  if (handler !== null && handler[1] !== undefined) return handler[1];
  return name;
}

/** A package name without its scope: "@insight/cli" -> "cli". A name with no scope is returned as it is. */
export function unscopedName(pkg: string): string {
  return pkg.replace(/^@[^/]+\//, "");
}

/**
 * The name a Node program's frame header gives it. A bin is its command (a plain string bin is its package, without the
 * scope); a package script is "<package> <script>"; a file no package names is its file's stem.
 */
export function programName(entry: { kind: "bin" | "script"; pkg: string; name: string } | undefined, file: string): string {
  if (entry === undefined) return stemOf(file);
  if (entry.kind === "bin") return unscopedName(entry.name);
  return `${unscopedName(entry.pkg)} ${entry.name}`;
}

/** A program the frame headers name: a browser page (its file), a Node script (its entry), or a build target (not named here). */
export interface ProgramHeaderInput {
  id: string;
  name: string;
  kind?: "browser" | "node";
  entry?: { kind: "bin" | "script"; pkg: string; name: string };
}

/**
 * The name each entry program's header shows, by program id. When two programs would show the same name, each gets its
 * file's stem in brackets, "server (main)"; if that still ties, its whole file path. Build targets are left out.
 */
export function programHeaderNames(programs: readonly ProgramHeaderInput[]): Map<string, string> {
  const entryPrograms = programs.filter((p) => p.kind !== undefined);
  const base = new Map<string, string>();
  for (const p of entryPrograms) base.set(p.id, p.kind === "browser" ? p.name : programName(p.entry, p.name));
  const countOf = (labels: Map<string, string>, label: string): number => [...labels.values()].filter((v) => v === label).length;
  const first = new Map<string, string>();
  for (const p of entryPrograms) {
    const label = base.get(p.id) ?? p.name;
    const stem = stemOf(p.name);
    first.set(p.id, countOf(base, label) > 1 ? `${label} (${stem})` : label);
  }
  const out = new Map<string, string>();
  for (const p of entryPrograms) {
    const label = first.get(p.id) ?? p.name;
    out.set(p.id, countOf(first, label) > 1 ? p.name : label);
  }
  return out;
}
