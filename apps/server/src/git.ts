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

/** Clones a repository, or fast-forwards an existing clone. Returns the checkout's HEAD commit. */
export async function syncCheckout(url: string, dir: string): Promise<string> {
  if (existsSync(join(dir, ".git"))) {
    await git(dir, ["pull", "--ff-only", "--quiet"]);
  } else {
    await git(undefined, ["clone", "--quiet", url, dir]);
  }
  return headOf(dir) as Promise<string>;
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
