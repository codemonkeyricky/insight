import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Runs git without a shell. Arguments are passed as an array, never interpolated. */
async function git(cwd: string | undefined, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

export interface SyncResult {
  /** The HEAD commit of the checkout that gets indexed. */
  commit: string;
  /** Set when the remote could not be reached and the last clone is indexed instead. The run log shows it. */
  warning?: string;
}

/**
 * Clones a repository, or fast-forwards an existing clone. When the fast-forward fails (offline, or the remote is
 * unreachable), the last clone is kept and indexed, with a warning. A first clone that fails is an error.
 */
export async function syncCheckout(url: string, dir: string): Promise<SyncResult> {
  if (existsSync(join(dir, ".git"))) {
    try {
      await git(dir, ["pull", "--ff-only", "--quiet"]);
    } catch (err) {
      const commit = await headOf(dir);
      if (commit === undefined) throw err;
      const reason = (err instanceof Error ? err.message : String(err)).split("\n")[0];
      return { commit, warning: `could not update ${url}; indexing the last fetched copy (${reason})` };
    }
  } else {
    await git(undefined, ["clone", "--quiet", url, dir]);
  }
  return { commit: (await headOf(dir)) as string };
}

/** The HEAD commit of a checkout, or undefined when the folder is not a git repository. */
export async function headOf(dir: string): Promise<string | undefined> {
  if (!existsSync(join(dir, ".git"))) return undefined;
  try {
    return await git(dir, ["rev-parse", "HEAD"]);
  } catch {
    return undefined;
  }
}

/** True when the checkout has uncommitted changes. Undefined when the folder is not a git repository. */
export async function isDirty(dir: string): Promise<boolean | undefined> {
  if (!existsSync(join(dir, ".git"))) return undefined;
  try {
    return (await git(dir, ["status", "--porcelain", "--untracked-files=no"])).length > 0;
  } catch {
    return undefined;
  }
}
