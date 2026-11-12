// Test fixtures: a tiny TypeScript project packed as a GitHub-style tarball, and a fake GitHub (REST + codeload)
// that answers the hosted indexer's requests without the network.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as tar from "tar";
import type { FetchLike } from "../src/index.js";

export const SHA = "0123456789abcdef0123456789abcdef01234567";
export const NOW = Date.parse("2026-11-11T12:00:00.000Z");

export const FIXTURE: Record<string, string> = {
  "package.json": JSON.stringify({ name: "proj", version: "0.0.0", private: true }),
  "tsconfig.json": JSON.stringify({
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true },
    include: ["src"],
  }),
  "src/a.ts": `import { b } from "./b.js";\nexport function a(): number {\n  return b() + 1;\n}\n`,
  "src/b.ts": `export function b(): number {\n  return 2;\n}\n`,
};

/** A gzipped tarball whose single top folder holds `files` (and `links`, as symlinks), like codeload's output. */
export async function makeTarball(files: Record<string, string>, links: Record<string, string> = {}): Promise<Uint8Array> {
  const parent = mkdtempSync(join(tmpdir(), "hosted-tar-"));
  const top = "widget-main";
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(parent, top, path)), { recursive: true });
      writeFileSync(join(parent, top, path), content);
    }
    for (const [path, target] of Object.entries(links)) {
      mkdirSync(dirname(join(parent, top, path)), { recursive: true });
      symlinkSync(target, join(parent, top, path));
    }
    const chunks: Buffer[] = [];
    for await (const chunk of tar.c({ gzip: true, cwd: parent }, [top])) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

export interface FakeRepo {
  size?: number;
  private?: boolean;
  missing?: boolean;
}

export interface FakeGithub {
  fetch: FetchLike;
  /** "METHOD url" for each request the fake answered. */
  calls: string[];
}

/** Answers api.github.com (repo, commits/<ref>) and codeload.github.com (tarball) for the given repos. */
export function fakeGithub(repos: Record<string, FakeRepo>, tarball: Uint8Array): FakeGithub {
  const calls: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    const api = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)(\/commits\/(.+))?$/.exec(url);
    if (api) {
      const name = `${api[1]}/${api[2]}`;
      const repo = repos[name];
      if (!repo || repo.missing) return Response.json({ message: "Not Found" }, { status: 404 });
      if (api[3] === undefined) {
        return Response.json({ default_branch: "main", size: repo.size ?? 12, private: repo.private ?? false });
      }
      const ref = decodeURIComponent(api[4] ?? "");
      if (ref === "no-such-ref") return Response.json({ message: "No commit found" }, { status: 422 });
      return Response.json({ sha: ref.length === 40 ? ref : SHA });
    }
    const code = /^https:\/\/codeload\.github\.com\/([^/]+)\/([^/]+)\/tar\.gz\/([0-9a-f]{40})$/.exec(url);
    if (code) {
      const repo = repos[`${code[1]}/${code[2]}`];
      if (!repo || repo.missing) return new Response("not found", { status: 404 });
      return new Response(tarball, { status: 200, headers: { "content-type": "application/gzip" } });
    }
    return new Response(`unexpected ${url}`, { status: 599 });
  };
  return { fetch, calls };
}

/** The files under a folder, relative and sorted. */
export function listFiles(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, prefix))) {
    const rel = prefix === "" ? entry : `${prefix}/${entry}`;
    if (statSync(join(root, rel)).isDirectory()) out.push(...listFiles(root, rel));
    else out.push(rel);
  }
  return out.sort();
}
