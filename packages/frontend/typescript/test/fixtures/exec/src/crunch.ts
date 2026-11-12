import { parentPort } from "node:worker_threads";

// A worker's top-level code runs when it starts, so the script itself is what the spawn runs.
parentPort?.postMessage("ready");
