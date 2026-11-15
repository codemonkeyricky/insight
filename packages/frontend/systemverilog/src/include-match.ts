import { posix } from "node:path";

/** How an `include text names project files: the one at its path from the including file, and the files whose path ends with it. */
export interface IncludeMatch {
  /** The file at the text's path relative to the including file's directory, when the project holds it. */
  exact?: string;
  /** Files whose path is the text, or ends with it, once leading "./" and "../" segments are dropped. In project order. */
  suffix: string[];
}

/** A project's files, looked up once for every include in it. */
export interface IncludeIndex {
  known: Set<string>;
  /** Each file under every path suffix that starts after a "/" (and under its whole path), in project order. */
  bySuffix: Map<string, string[]>;
}

/** Indexes a project's files for matchInclude. Build it once per project. */
export function indexIncludes(projectFiles: Iterable<string>): IncludeIndex {
  const known = new Set<string>();
  const bySuffix = new Map<string, string[]>();
  const add = (key: string, file: string): void => {
    const list = bySuffix.get(key);
    if (list) list.push(file);
    else bySuffix.set(key, [file]);
  };
  for (const file of projectFiles) {
    known.add(file);
    add(file, file);
    for (let i = file.indexOf("/"); i !== -1; i = file.indexOf("/", i + 1)) add(file.slice(i + 1), file);
  }
  return { known, bySuffix };
}

/**
 * The one way every `include is matched to project files, so the linker and the resolver agree. The text is taken
 * relative to the including file first. Failing that, it is matched by path suffix, once leading "./" and "../"
 * segments are dropped.
 */
export function matchInclude(includingFile: string, text: string, index: IncludeIndex): IncludeMatch {
  const normalized = posix.normalize(posix.join(posix.dirname(includingFile), text));
  const exact = index.known.has(normalized) ? normalized : undefined;
  const t = text.replace(/^(?:\.{1,2}\/)+/, "");
  const suffix = index.bySuffix.get(t) ?? [];
  return exact !== undefined ? { exact, suffix } : { suffix };
}
