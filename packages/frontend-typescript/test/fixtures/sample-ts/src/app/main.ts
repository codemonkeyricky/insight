import { add, double, Counter } from "../lib/math.js";
import { loadConfig } from "../lib/io.js";

export function run(values: number[]): number {
  let total = 0;
  for (const v of values) {
    total = add(total, double(v));
  }
  const counter = new Counter();
  counter.increment(total);
  return total > 10 ? counter.increment(1) : total;
}

export async function start(): Promise<void> {
  try {
    const cfg = await loadConfig(process.env.CONFIG_PATH ?? "config.json");
    console.log(cfg, run([1, 2, 3]));
  } catch (err) {
    throw err;
  }
}
