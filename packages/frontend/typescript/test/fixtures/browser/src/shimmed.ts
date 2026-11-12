import { Worker } from "./shim.js";

// An imported Worker is the project's own class, not the browser global, so this spawns no thread.
export const local = new Worker("./verify/verify.worker.ts");
