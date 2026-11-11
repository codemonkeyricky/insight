// The deployment's wiring: storage from the environment (R2 when R2_* is set, else a folder from INSIGHT_STORAGE_DIR)
// and the default dependencies for handleIndex.
import { exportProject } from "@insight/export";
import { r2Storage, fsStorage, type Storage } from "./storage.js";
import type { IndexDeps } from "./indexer.js";

type Env = Record<string, string | undefined>;

const R2_VARS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"] as const;

/** R2 when any R2_* variable is set (then all of them are required), else the folder in INSIGHT_STORAGE_DIR. */
export function storageFromEnv(env: Env): Storage {
  if (R2_VARS.some((name) => env[name])) {
    const missing = R2_VARS.filter((name) => !env[name]);
    if (missing.length > 0) throw new Error(`R2 storage needs ${missing.join(", ")}`);
    return r2Storage({
      accountId: env.R2_ACCOUNT_ID as string,
      accessKeyId: env.R2_ACCESS_KEY_ID as string,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY as string,
      bucket: env.R2_BUCKET as string,
    });
  }
  if (env.INSIGHT_STORAGE_DIR) return fsStorage(env.INSIGHT_STORAGE_DIR);
  throw new Error("no storage configured: set R2_* or INSIGHT_STORAGE_DIR");
}

/** The dependencies handleIndex runs with in production. Pass `waitUntil` from the host (Vercel). */
export function buildDeps(env: Env = process.env, overrides: Partial<IndexDeps> = {}): IndexDeps {
  return {
    storage: storageFromEnv(env),
    env,
    fetch: (input, init) => fetch(input, init),
    waitUntil: (promise) => {
      promise.catch(() => undefined);
    },
    now: () => Date.now(),
    exportProject,
    tmpRoot: env.INSIGHT_TMP_DIR || "/tmp/insight",
    ...overrides,
  };
}
