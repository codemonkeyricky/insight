/**
 * A local's name for display: its `name@line` (or `name@line:col`) key, as the frontend emits a local the function declares more
 * than once, without the line. A bare name passes through unchanged. Shared by every view that shows a local's name.
 */
export function displayLocal(key: string): string {
  return key.replace(/@\d+(?::\d+)?$/, "");
}
