import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "insight-plugin.json"), "utf8")) as { inputs: string[] };

describe("insight-plugin.json inputs", () => {
  it("lists every index.html, so editing a nested page invalidates the frontend's output", () => {
    expect(manifest.inputs).toContain("**/index.html");
  });
});
