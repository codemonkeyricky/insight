// The name a reader sees for a function on the map and in a chart. Display only: ids, URLs and the model keep the full name.
// A named function shows its name. Module-level code shows its file's base name without the last extension ("src/main.tsx"
// -> "main"). A folded handler shows its event ("verify.worker.ts · on message" -> "on message").

const MODULE_SUFFIX = "#(module)";
const TOP_LEVEL = " · top level";

/** The base name of a file without its last extension: "src/verify/slice.worker.ts" -> "slice.worker". */
function stemOf(file: string): string {
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
