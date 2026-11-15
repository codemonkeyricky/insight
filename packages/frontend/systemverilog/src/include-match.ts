import { posix } from "node:path";

/** How an `include text names project files: the one at its path from the including file, and the files whose path ends with it. */
export interface IncludeMatch {
  /** The file at the text's path relative to the including file's directory, when the project holds it. */
  exact?: string;
  /** Files whose path is the text, or ends with it, once leading "./" and "../" segments are dropped. In project order. */
  suffix: string[];
}

/**
 * The one way every `include is matched to project files, so the linker and the resolver agree. The text is taken
 * relative to the including file first. Failing that, it is matched by path suffix.
 */
export function matchInclude(includingFile: string, text: string, projectFiles: Iterable<string>): IncludeMatch {
  const files = [...projectFiles];
  const relative = posix.join(posix.dirname(includingFile), text);
  const normalized = posix.normalize(relative);
  const exact = new Set(files).has(normalized) ? normalized : undefined;
  const t = text.replace(/^(?:\.{1,2}\/)+/, "");
  const suffix = files.filter((f) => f === t || f.endsWith(`/${t}`));
  return exact !== undefined ? { exact, suffix } : { suffix };
}
