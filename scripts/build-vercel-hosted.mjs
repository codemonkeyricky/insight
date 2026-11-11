#!/usr/bin/env node
// Packages the hosted deployment in the Vercel Build Output API layout:
//
//   <outDir>/.vercel/output/config.json                version 3: files first, then the API rewrites, then /index.html
//   <outDir>/.vercel/output/static/                    the hosted web build (VITE_STORAGE_BASE = KV_PUBLIC_BASE/)
//   <outDir>/.vercel/output/functions/api/index.func   one Function: POST /api/index, GET /api/status, GET /api/health
//                                                      (self-contained Node bundle; the route comes from ?route=)
//
// The Function holds node_modules from `pnpm deploy --prod` (hoisted linker, so no symlinks), the hosted dist, the built-in
// plugins under packages/ and plugins/, and a pnpm-workspace.yaml marker at its root. Core finds built-in plugins by walking
// up from its own file to pnpm-workspace.yaml, so the marker makes that root the bundle, not the repository.
// better-sqlite3 is dropped: the hosted export never opens index.sqlite (writeIndexDb is false), and it is imported lazily.
//
//   KV_PUBLIC_BASE=https://insight-storage.<account>.workers.dev node scripts/build-vercel-hosted.mjs <outDir>
//   (KV_PUBLIC_BASE falls back to R2_PUBLIC_BASE)
//   then: cd <outDir> && vercel deploy --prebuilt --prod --archive=tgz
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FUNCTION_LIMIT_BYTES = 250 * 1024 * 1024;
/** One Function serves every API route (see packages/hosted/src/vercel.ts). */
const FUNCTIONS = [{ dir: "functions/api/index.func" }];
/** The API paths the rewrites send to the Function, each with its route name. */
const API_ROUTES = [
  { src: "/api/index", route: "index" },
  { src: "/api/status", route: "status" },
  { src: "/api/health", route: "health" },
];

function fail(message) {
  console.error(`build-vercel-hosted: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repo, stdio: "inherit", ...options });
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed with ${result.status ?? result.signal}`);
}

/** Total bytes and file count of a folder tree. Symlinks are counted as the files they point to. */
function treeSize(dir) {
  let bytes = 0;
  let files = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = treeSize(path);
      bytes += inner.bytes;
      files += inner.files;
    } else {
      bytes += statSync(path).size;
      files += 1;
    }
  }
  return { bytes, files };
}

/** The workspace packages that carry an insight-plugin.json: the built-in plugins, found the way core finds them. */
function builtinPlugins() {
  const found = [];
  for (const base of ["packages", "plugins"]) {
    const root = join(repo, base);
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root).sort()) {
      const dir = join(root, name);
      if (existsSync(join(dir, "insight-plugin.json"))) found.push({ base, name, dir });
    }
  }
  return found;
}

const outArg = process.argv[2];
if (!outArg) fail("usage: node scripts/build-vercel-hosted.mjs <outDir>  (env: KV_PUBLIC_BASE, or R2_PUBLIC_BASE)");
const publicBase = (process.env.KV_PUBLIC_BASE || process.env.R2_PUBLIC_BASE || "").replace(/\/+$/, "");
if (!/^https:\/\/[^/\s]+/.test(publicBase)) fail("KV_PUBLIC_BASE must be the public https URL of the storage Worker, e.g. https://insight-storage.<account>.workers.dev");

const out = resolve(outArg);
const outputRoot = join(out, ".vercel", "output");
rmSync(join(out, ".vercel"), { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });

// 1. The packages the function needs, built (the web build reads their types through tsc too).
run("pnpm", ["--filter", "@insight/hosted...", "build"]);

// 2. The hosted web build, pointed at the bucket's public URL.
const staticDir = join(outputRoot, "static");
run("pnpm", ["--filter", "@insight/web", "exec", "tsc", "-p", "tsconfig.json", "--noEmit"]);
run("pnpm", ["--filter", "@insight/web", "exec", "vite", "build", "--outDir", staticDir, "--emptyOutDir"], {
  cwd: join(repo, "apps", "web"),
  env: { ...process.env, VITE_HOSTED: "1", VITE_STORAGE_BASE: `${publicBase}/` },
});

// 3. One pnpm deploy of @insight/hosted (production dependencies, hoisted, no symlinks), then copied into each function.
const deployDir = mkdtempSync(join(tmpdir(), "insight-hosted-deploy-"));
try {
  run("pnpm", ["--filter", "@insight/hosted", "deploy", "--prod", "--config.node-linker=hoisted", deployDir]);
  const modules = join(deployDir, "node_modules");
  rmSync(join(modules, ".bin"), { recursive: true, force: true });
  rmSync(join(modules, "better-sqlite3"), { recursive: true, force: true });

  const plugins = builtinPlugins();
  for (const fn of FUNCTIONS) {
    const dest = join(outputRoot, fn.dir);
    mkdirSync(dest, { recursive: true });
    cpSync(modules, join(dest, "node_modules"), { recursive: true, dereference: true });
    cpSync(join(deployDir, "dist"), join(dest, "dist"), { recursive: true });
    cpSync(join(deployDir, "package.json"), join(dest, "package.json"));

    // Built-in plugins: packages/<dir> from the deployed copy (their dependencies resolve from node_modules above),
    // plugins/<dir> straight from the repository (no dependencies).
    for (const plugin of plugins) {
      const target = join(dest, plugin.base, plugin.name);
      mkdirSync(dirname(target), { recursive: true });
      if (plugin.base === "packages") {
        const pkg = JSON.parse(readFileSync(join(plugin.dir, "package.json"), "utf8")).name;
        const source = join(modules, ...pkg.split("/"));
        if (!existsSync(source)) fail(`${pkg} is not in the deployed node_modules; add it to packages/hosted dependencies`);
        cpSync(source, target, { recursive: true, dereference: true });
      } else {
        cpSync(plugin.dir, target, { recursive: true, dereference: true });
      }
    }
    writeFileSync(join(dest, "pnpm-workspace.yaml"), "# Marks this bundle as the root for built-in plugin discovery (packages/, plugins/).\npackages: []\n");

    writeFileSync(
      join(dest, "handler.mjs"),
      `// Vercel Node entry: every API route (index, status, health). The default export takes (req, res).\nimport { nodeHandler } from "./dist/vercel-node.js";\nexport default nodeHandler();\n`,
    );
    writeFileSync(
      join(dest, ".vc-config.json"),
      `${JSON.stringify(
        {
          runtime: "nodejs22.x",
          handler: "handler.mjs",
          launcherType: "Nodejs",
          shouldAddHelpers: false,
          supportsResponseStreaming: true,
          maxDuration: 300,
          memory: 2048,
        },
        null,
        2,
      )}\n`,
    );
  }
} finally {
  rmSync(deployDir, { recursive: true, force: true });
}

// 4. The routing: real files first, then the API rewrites (each sends its route name as ?route=, so the Function does not
// depend on the path it is reached by), then the app shell for client-side routes.
const apiRoutes = API_ROUTES.map(({ src, route }) => ({ src: `^${src}$`, dest: `/api/index?route=${route}` }));
writeFileSync(
  join(outputRoot, "config.json"),
  `${JSON.stringify({ version: 3, routes: [{ handle: "filesystem" }, ...apiRoutes, { src: "/(.*)", dest: "/index.html" }] }, null, 2)}\n`,
);

// 5. Report: each function's unzipped size and file count, checked against the 250 MB limit.
let over = false;
for (const fn of FUNCTIONS) {
  const { bytes, files } = treeSize(join(outputRoot, fn.dir));
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  console.log(`${fn.dir}: ${mb} MB unzipped, ${files} files`);
  if (bytes >= FUNCTION_LIMIT_BYTES) over = true;
}
if (over) fail("a function is over the 250 MB unzipped limit");
console.log(`packaged ${outputRoot}; deploy with: cd ${out} && vercel deploy --prebuilt --prod --archive=tgz`);
