// Resolver: answers a C++ include with the headers found through a target's include directories, and, when no
// in-repository header explains it, with the external package the target's dependencies declare.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { externalsForInclude } from "@insight/sdk";
import { buildCmakeModel, closureOf, includeDirsOf, isCMakeFile, ownersOf, resolveLink } from "./parse.js";

/**
 * The model of the last link run. It is reused while the file list is the same array with the same length and the
 * CMake texts hash to the same digest, so an edit to any CMake file is still seen at once.
 */
let cached;

function digestOf(texts) {
  const hash = createHash("sha256");
  for (const key of [...texts.keys()].sort()) {
    const text = texts.get(key);
    hash.update(`${key}\0${text.length}\0${text}\0`);
  }
  return hash.digest("hex");
}

async function readTexts(ctx) {
  const texts = new Map();
  for (const f of ctx.listFiles()) {
    if (isCMakeFile(f)) texts.set(f, await readFile(join(ctx.root.path, f), "utf8"));
  }
  return texts;
}

/**
 * With a runCache (one per link run, see ResolveContext.runCache) the model is built once per run and stored there as
 * a Promise, so the files are not read again. Without it the model is rebuilt when the file list or the CMake texts
 * change, checked by the digest of those texts.
 */
function loadModel(ctx) {
  if (ctx.runCache !== undefined) {
    const cache = ctx.runCache;
    const key = "frontend-cmake:model";
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const pending = readTexts(ctx)
      .then((texts) => buildCmakeModel(texts, ctx.listFiles()))
      .catch((err) => {
        cache.delete(key);
        throw err;
      });
    cache.set(key, pending);
    return pending;
  }
  return loadModelByDigest(ctx);
}

async function loadModelByDigest(ctx) {
  const files = ctx.listFiles();
  const texts = await readTexts(ctx);
  const digest = digestOf(texts);
  if (cached !== undefined && cached.files === files && cached.count === files.length && cached.digest === digest) {
    return cached.model;
  }
  const model = buildCmakeModel(texts, files);
  cached = { files, count: files.length, digest, model };
  return model;
}

/** The external packages the closure's links name, by id. */
function externalsOfClosure(model, closure) {
  const ids = new Set();
  for (const t of closure) {
    for (const link of t.links) {
      const r = resolveLink(model, link.name);
      if (r !== undefined && r.kind === "external") ids.add(r.id);
    }
  }
  return ids;
}

export default {
  scheme: "cpp.include",
  priority: 80,
  async resolve(ref, ctx) {
    const model = await loadModel(ctx);
    const owners = ownersOf(model, ctx.fromFile);
    const text = ref.text.replace(/^\.\//, "");
    const matches = new Set();
    for (const owner of owners) {
      for (const dir of includeDirsOf(model, owner)) {
        const candidate = posix.normalize(posix.join(dir, text));
        if (ctx.hasFile(candidate)) matches.add(candidate);
      }
    }
    if (matches.size > 0) return { targets: [...matches].sort(), confidence: "inferred", note: "via CMake include directories" };

    // No owner target: every declared external is a candidate. Otherwise, only those the owners' closure depends on.
    const scope =
      owners.length === 0 ? [...model.externals.keys()] : [...externalsOfClosure(model, closureOf(model, owners))];
    const candidates = [];
    for (const id of scope) {
      const ext = model.externals.get(id);
      if (ext === undefined || !ctx.hasNode(id)) continue;
      candidates.push({ id, name: ext.name });
    }
    const ids = externalsForInclude(text, candidates).map((m) => m.id);
    if (ids.length === 0) return null;
    // Through an owner's dependency closure the external is declared as a dependency: inferred. With no owner,
    // any declared external may match, which is only a guess: heuristic.
    return {
      targets: ids,
      confidence: owners.length === 0 ? "heuristic" : "inferred",
      note: `external package: ${ids.join(", ")}`,
    };
  },
};
