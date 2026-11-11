/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" in the hosted build: indexed GitHub repositories. */
  readonly VITE_HOSTED?: string;
  /** Where the hosted build reads its indexes (the storage Worker's public URL in production). Default: "/storage/". */
  readonly VITE_STORAGE_BASE?: string;
  /** The origin of the hosted API for /api/index and /api/status. Default: "" (the same origin). */
  readonly VITE_API_BASE?: string;
}
