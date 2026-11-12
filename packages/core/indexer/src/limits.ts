/** Caps on what one index run reads. An unset cap means no cap, which is the local default. */
export interface IndexLimits {
  /** Most files a run may index. A run over this fails with IndexLimitError. */
  maxFiles?: number;
  /** Largest file a run reads. A larger file is skipped with a warning. */
  maxFileBytes?: number;
  /** Most bytes, summed over the indexed files, a run may read. A run over this fails with IndexLimitError. */
  maxTotalBytes?: number;
}

/** A run stopped by a cap. The message says which cap was passed, and by how much. */
export class IndexLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexLimitError";
  }
}

/** 54321 becomes "54,321". */
export function formatCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** A byte count in the unit that reads best: 900 becomes "900 bytes", 2048 "2.0 KiB", 1048576 "1.0 MiB". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} bytes`;
}
