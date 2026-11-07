// Static reader for CMakeLists.txt. It follows the commands that declare targets, their sources,
// link items and include directories. It does not evaluate generator expressions or run cmake.
// Limits: variables set in a parent directory are not visible in a subdirectory, and absolute
// paths outside the project are read as if they were project-relative.
import { posix } from "node:path";

const WS = new Set([" ", "\t", "\r", "\n"]);
const TARGET_KEYWORDS = new Set([
  "STATIC", "SHARED", "MODULE", "OBJECT", "INTERFACE", "UNKNOWN", "WIN32", "MACOSX_BUNDLE",
  "EXCLUDE_FROM_ALL", "IMPORTED", "GLOBAL", "ALIAS", "PRIVATE", "PUBLIC", "LINK_PUBLIC",
  "LINK_PRIVATE", "LINK_INTERFACE_LIBRARIES", "SYSTEM", "BEFORE", "AFTER", "debug", "optimized", "general",
]);
const SET_STOP = new Set(["CACHE", "PARENT_SCOPE"]);

export function isCMakeFile(path) {
  return posix.basename(path) === "CMakeLists.txt";
}

export function dirOf(file) {
  const d = posix.dirname(file);
  return d === "." ? "" : d;
}

export function joinPath(...parts) {
  const s = posix.join(...parts.filter((p) => p !== ""));
  return s === "." ? "" : s;
}

/** Glob to regex over project-relative paths. ** crosses directories, * and ? do not. */
export function globRegex(pattern) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern.charAt(i);
    if (c === "*" && pattern.charAt(i + 1) === "*") {
      if (pattern.charAt(i + 2) === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Every command in the file: name, arguments (quoted flag kept) and its span. */
export function parseCommands(text) {
  const out = [];
  const n = text.length;
  let i = 0;
  let line = 0;
  let col = 0;
  const adv = (k) => {
    for (let q = 0; q < k && i < n; q++) {
      if (text[i] === "\n") {
        line++;
        col = 0;
      } else col++;
      i++;
    }
  };
  const skipSpace = () => {
    while (i < n) {
      const c = text[i];
      if (WS.has(c)) adv(1);
      else if (c === "#") {
        while (i < n && text[i] !== "\n") adv(1);
      } else break;
    }
  };

  while (i < n) {
    skipSpace();
    if (i >= n) break;
    if (!/[A-Za-z_]/.test(text[i])) {
      adv(1);
      continue;
    }
    let j = i;
    while (j < n && /[A-Za-z0-9_]/.test(text[j])) j++;
    let k = j;
    while (k < n && (text[k] === " " || text[k] === "\t")) k++;
    if (text[k] !== "(") {
      adv(j - i);
      continue;
    }
    const name = text.slice(i, j).toLowerCase();
    const sl = line;
    const sc = col;
    adv(k + 1 - i);
    const args = [];
    let end = null;
    while (i < n) {
      skipSpace();
      if (i >= n) break;
      const ch = text[i];
      if (ch === ")") {
        adv(1);
        end = [line, col];
        break;
      }
      if (ch === '"') {
        adv(1);
        let s = "";
        while (i < n && text[i] !== '"') {
          if (text[i] === "\\" && i + 1 < n) {
            const e = text[i + 1];
            s += e === "n" ? "\n" : e === "t" ? "\t" : e;
            adv(2);
          } else {
            s += text[i];
            adv(1);
          }
        }
        adv(1);
        args.push({ text: s, quoted: true });
        continue;
      }
      // An unquoted word. Parentheses inside it nest; a closing one at depth zero ends the command.
      let s = "";
      let wd = 0;
      const start = i;
      while (i < n) {
        const c = text[i];
        if (c === "(") wd++;
        else if (c === ")") {
          if (wd === 0) break;
          wd--;
        } else if ((WS.has(c) || c === '"' || c === "#") && wd === 0) break;
        s += c;
        adv(1);
      }
      if (i === start) adv(1);
      else args.push({ text: s, quoted: false });
    }
    if (end === null) end = [line, col];
    out.push({ name, args, span: { start: [sl, sc], end } });
  }
  return out;
}

/** Substitutes ${VAR} and splits lists on ;. Undefined variables expand to nothing, as in CMake. */
function expand(args, vars) {
  const out = [];
  for (const a of args) {
    const s = a.text.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_m, name) => (vars.has(name) ? vars.get(name).join(";") : ""));
    for (const part of s.split(";")) if (part !== "") out.push(part);
  }
  return out;
}

/** A path as CMake sees it: a leading slash is project-root relative, anything else is relative to the directory. */
function resolvePath(p, dir) {
  if (p.startsWith("/")) return joinPath(p.replace(/^\/+/, ""));
  return joinPath(dir, p);
}

/** Include directory items. Generator expressions are read only for BUILD_INTERFACE. */
function includeItem(p, dir) {
  if (p.startsWith("$<BUILD_INTERFACE:") && p.endsWith(">")) return resolvePath(p.slice("$<BUILD_INTERFACE:".length, -1), dir);
  if (p.startsWith("$<")) return undefined;
  return resolvePath(p, dir);
}

/**
 * Reads one CMakeLists.txt. Targets it declares are returned as definitions. Commands that touch
 * a target, such as target_sources, are returned as operations to apply once every file is read.
 */
function readFile(dir, buildFile, text, files) {
  const vars = new Map([
    ["CMAKE_CURRENT_SOURCE_DIR", [`/${dir}`]],
    ["CMAKE_CURRENT_LIST_DIR", [`/${dir}`]],
    ["CMAKE_SOURCE_DIR", ["/"]],
    ["PROJECT_SOURCE_DIR", ["/"]],
  ]);
  const defs = [];
  const ops = [];
  for (const cmd of parseCommands(text)) {
    const args = cmd.args;
    const raw = (k) => args[k]?.text ?? "";
    switch (cmd.name) {
      case "set": {
        if (args.length === 0) break;
        const values = [];
        for (const v of expand(args.slice(1), vars)) {
          if (SET_STOP.has(v)) break;
          values.push(v);
        }
        vars.set(raw(0), values);
        break;
      }
      case "list": {
        if (raw(0).toUpperCase() !== "APPEND" || args.length < 2) break;
        const name = raw(1);
        vars.set(name, [...(vars.get(name) ?? []), ...expand(args.slice(2), vars)]);
        break;
      }
      case "file": {
        const op = raw(0).toUpperCase();
        if (op !== "GLOB" && op !== "GLOB_RECURSE") break;
        const patterns = expand(args.slice(2), vars).filter((p) => p !== "CONFIGURE_DEPENDS");
        const matches = new Set();
        for (const p of patterns) {
          const rel = p.replace(/^\/+/, "");
          let re;
          if (op === "GLOB") re = globRegex(joinPath(dir, rel));
          else {
            const slash = rel.lastIndexOf("/");
            const head = slash >= 0 ? rel.slice(0, slash) : "";
            const base = slash >= 0 ? rel.slice(slash + 1) : rel;
            re = globRegex(joinPath(dir, head, "**", base));
          }
          for (const f of files) if (re.test(f)) matches.add(`/${f}`);
        }
        vars.set(raw(1), [...matches].sort());
        break;
      }
      case "add_library":
      case "add_executable": {
        const name = raw(0);
        const rest = expand(args.slice(1), vars);
        const upper = rest.map((v) => v.toUpperCase());
        if (name === "" || upper.includes("ALIAS") || upper.includes("IMPORTED")) break;
        const sources = rest.filter((v) => !TARGET_KEYWORDS.has(v) && !TARGET_KEYWORDS.has(v.toUpperCase()) && !v.startsWith("$<")).map((p) => resolvePath(p, dir));
        defs.push({ name, kind: cmd.name, dir, buildFile, span: cmd.span, sources });
        break;
      }
      case "target_sources": {
        const items = expand(args.slice(1), vars).filter((v) => !TARGET_KEYWORDS.has(v.toUpperCase()) && !v.startsWith("$<"));
        ops.push({ op: "sources", name: raw(0), paths: items.map((p) => resolvePath(p, dir)) });
        break;
      }
      case "target_include_directories": {
        // The scope keyword applies to the items after it, so one command may mix PUBLIC and PRIVATE.
        let scope = "PUBLIC";
        for (const v of expand(args.slice(1), vars)) {
          const u = v.toUpperCase();
          if (u === "PUBLIC" || u === "PRIVATE" || u === "INTERFACE") {
            scope = u;
            continue;
          }
          if (u === "SYSTEM" || u === "BEFORE" || u === "AFTER") continue;
          const d = includeItem(v, dir);
          if (d === undefined) continue;
          ops.push({ op: "include", name: raw(0), usage: scope !== "PRIVATE", local: scope !== "INTERFACE", dir: d });
        }
        break;
      }
      case "target_link_libraries": {
        let scope = "PUBLIC";
        for (const v of expand(args.slice(1), vars)) {
          const u = v.toUpperCase();
          if (u === "PUBLIC" || u === "PRIVATE" || u === "INTERFACE") {
            scope = u;
            continue;
          }
          if (["LINK_PUBLIC", "LINK_PRIVATE", "LINK_INTERFACE_LIBRARIES", "DEBUG", "OPTIMIZED", "GENERAL"].includes(u)) continue;
          ops.push({ op: "link", name: raw(0), propagates: scope !== "PRIVATE", items: [v] });
        }
        break;
      }
      default:
        break;
    }
  }
  return { defs, ops };
}

/**
 * Every CMakeLists.txt in the project, read into one model keyed by target name. A name declared in
 * two places keeps its first definition. Target ids are cmake://<directory>:<name>.
 */
export function buildCmakeModel(texts, files) {
  const targets = new Map();
  const allOps = [];
  for (const file of [...texts.keys()].sort()) {
    const { defs, ops } = readFile(dirOf(file), file, texts.get(file), files);
    for (const d of defs) {
      if (targets.has(d.name)) continue;
      targets.set(d.name, {
        name: d.name,
        id: `cmake://${d.dir}:${d.name}`,
        kind: d.kind,
        buildFile: d.buildFile,
        span: d.span,
        sources: [...d.sources],
        publicDirs: [],
        privateDirs: [],
        links: [],
      });
    }
    allOps.push(...ops);
  }
  for (const op of allOps) {
    const t = targets.get(op.name);
    if (!t) continue;
    if (op.op === "sources") t.sources.push(...op.paths);
    else if (op.op === "include") {
      if (op.usage) t.publicDirs.push(op.dir);
      if (op.local) t.privateDirs.push(op.dir);
    } else if (op.op === "link") {
      for (const name of op.items) t.links.push({ name, propagates: op.propagates });
    }
  }
  return { targets };
}

/** Include directories a target's own sources see: its own, plus what the libraries it links export. */
export function includeDirsOf(model, owner) {
  const out = [...owner.publicDirs, ...owner.privateDirs];
  for (const link of owner.links) out.push(...usageDirs(model, link.name, new Set([owner.name])));
  return [...new Set(out)];
}

function usageDirs(model, name, seen) {
  const t = model.targets.get(name);
  if (!t || seen.has(name)) return [];
  seen.add(name);
  const out = [...t.publicDirs];
  for (const link of t.links) if (link.propagates) out.push(...usageDirs(model, link.name, seen));
  return out;
}

export function ownersOf(model, file) {
  return [...model.targets.values()].filter((t) => t.sources.includes(file));
}
