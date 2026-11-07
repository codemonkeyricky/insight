// Resolver: answers a C++ include with the headers found through a target's include directories.
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { buildCmakeModel, includeDirsOf, isCMakeFile, ownersOf } from "./parse.js";

async function loadModel(ctx) {
  const texts = new Map();
  for (const f of ctx.listFiles()) {
    if (isCMakeFile(f)) texts.set(f, await readFile(join(ctx.root.path, f), "utf8"));
  }
  return buildCmakeModel(texts, ctx.listFiles());
}

export default {
  scheme: "cpp.include",
  priority: 80,
  async resolve(ref, ctx) {
    const model = await loadModel(ctx);
    const owners = ownersOf(model, ctx.fromFile);
    if (owners.length === 0) return null;
    const text = ref.text.replace(/^\.\//, "");
    const matches = new Set();
    for (const owner of owners) {
      for (const dir of includeDirsOf(model, owner)) {
        const candidate = posix.normalize(posix.join(dir, text));
        if (ctx.hasFile(candidate)) matches.add(candidate);
      }
    }
    if (matches.size === 0) return null;
    return { targets: [...matches].sort(), confidence: "inferred", note: "via CMake include directories" };
  },
};
