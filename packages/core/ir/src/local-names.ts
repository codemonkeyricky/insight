/**
 * A local's name for display: its `name@line` (or `name@line:col`) key, as the frontend emits a local the function declares more
 * than once, without the line. A bare name passes through unchanged. Shared by every view that shows a local's name.
 */
export function displayLocal(key: string): string {
  return key.replace(/@\d+(?::\d+)?$/, "");
}

/**
 * The display names for one label set: `displayLocal` of each key, except that when two different keys in the set share a bare name
 * (`x@3` and `x@9`, two declarations of `x`), each shows its line, `x (line 3)`. Takes the key set; returns the mapping for its keys.
 */
export function displayLocals(keys: readonly string[]): (key: string) => string {
  const distinct = Array.from(new Set(keys));
  const count = new Map<string, number>();
  for (const k of distinct) count.set(displayLocal(k), (count.get(displayLocal(k)) ?? 0) + 1);
  return (key) => {
    const name = displayLocal(key);
    if ((count.get(name) ?? 0) < 2) return name;
    const line = /@(\d+)(?::\d+)?$/.exec(key)?.[1];
    return line === undefined ? name : `${name} (line ${line})`;
  };
}
