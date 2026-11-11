/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" in the hosted build: indexed GitHub repositories. */
  readonly VITE_HOSTED?: string;
  /** Where the hosted build reads its indexes (the R2 public base in production). Default: "/storage/". */
  readonly VITE_STORAGE_BASE?: string;
}
