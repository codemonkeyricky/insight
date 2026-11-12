import { readFileSync } from "node:fs";
import * as fs from "node:fs";

export async function loadConfig(path: string): Promise<string> {
  const text = readFileSync(path, "utf8");
  return text.trim();
}

export function listFiles(dir: string): string[] {
  return fs.readdirSync(dir);
}

export function elapsed(start: number): number {
  return Date.now() - start;
}
