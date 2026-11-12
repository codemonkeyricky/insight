// A fake GitHub App for the sign-in and private-repo tests: OAuth (code and refresh grants), the user, the installation
// repositories, the repo and commit lookups, the contents API and the tarball. Tokens are "tok-<login>[-suffix]"; a repo
// is readable by the logins in its `readers` list (a private repo by those only). No network.
import type { FetchLike } from "../src/index.js";
import { SHA } from "./helpers.js";

export interface AppRepo {
  private?: boolean;
  readers?: string[];
  size?: number;
  /** Text files the contents API serves, by path. */
  files?: Record<string, string>;
}

export interface AppFake {
  fetch: FetchLike;
  /** Each request the fake answered: method, url and the Authorization header (if any). */
  calls: { method: string; url: string; auth?: string }[];
}

const USER_IDS: Record<string, number> = { alice: 1, bob: 2 };

/** The login a token belongs to ("tok-alice..." → "alice"), or undefined. */
export function loginOfToken(token: string | undefined): string | undefined {
  const match = /^tok-([a-z]+)/.exec(token ?? "");
  return match?.[1];
}

function bearer(init: RequestInit | undefined): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined;
  const value = headers?.Authorization ?? headers?.authorization;
  return value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : undefined;
}

export function fakeApp(repos: Record<string, AppRepo>, tarball: Uint8Array): AppFake {
  const calls: AppFake["calls"] = [];
  const canRead = (name: string, login: string | undefined): boolean => {
    const repo = repos[name];
    if (!repo) return false;
    if (!repo.private) return true;
    return login !== undefined && (repo.readers ?? []).includes(login);
  };

  const fetch: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const token = bearer(init);
    calls.push({ method, url, auth: token === undefined ? undefined : `Bearer ${token}` });
    const login = loginOfToken(token);

    if (url === "https://github.com/login/oauth/access_token" && method === "POST") {
      const form = new URLSearchParams(String(init?.body ?? ""));
      if (form.get("grant_type") === "refresh_token") {
        const refresh = form.get("refresh_token") ?? "";
        if (!/^ref-[a-z]+$/.test(refresh)) return Response.json({ error: "bad_refresh_token" });
        const who = refresh.slice("ref-".length);
        return Response.json({
          access_token: `tok-${who}-refreshed`,
          token_type: "bearer",
          expires_in: 28800,
          refresh_token: `ref-${who}-2`,
          refresh_token_expires_in: 15552000,
        });
      }
      const code = form.get("code") ?? "";
      if (!/^code-[a-z]+$/.test(code)) return Response.json({ error: "bad_verification_code" });
      const who = code.slice("code-".length);
      return Response.json({
        access_token: `tok-${who}`,
        token_type: "bearer",
        expires_in: 28800,
        refresh_token: `ref-${who}`,
        refresh_token_expires_in: 15552000,
      });
    }

    if (url === "https://api.github.com/user") {
      if (login === undefined) return Response.json({ message: "Bad credentials" }, { status: 401 });
      return Response.json({ id: USER_IDS[login] ?? 9, login, avatar_url: `https://avatars.test/${login}.png` });
    }

    if (url.startsWith("https://api.github.com/user/installations?")) {
      if (login === undefined) return Response.json({ message: "Requires authentication" }, { status: 401 });
      return Response.json({ total_count: 1, installations: [{ id: 100 }] });
    }

    const repositories = /^https:\/\/api\.github\.com\/user\/installations\/(\d+)\/repositories\?/.exec(url);
    if (repositories) {
      if (login === undefined) return Response.json({ message: "Requires authentication" }, { status: 401 });
      const list = Object.entries(repos)
        .filter(([, repo]) => (repo.readers ?? []).includes(login))
        .map(([name, repo]) => ({ full_name: name, private: repo.private ?? false, default_branch: "main" }));
      return Response.json({ total_count: list.length, repositories: list });
    }

    const tarballUrl = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/tarball\/([0-9a-f]{40})$/.exec(url);
    if (tarballUrl) {
      const name = `${tarballUrl[1]}/${tarballUrl[2]}`;
      if (!canRead(name, login)) return new Response("not found", { status: 404 });
      return new Response(tarball, { status: 200, headers: { "content-type": "application/gzip" } });
    }

    const code = /^https:\/\/codeload\.github\.com\/([^/]+)\/([^/]+)\/tar\.gz\/([0-9a-f]{40})$/.exec(url);
    if (code) {
      const name = `${code[1]}/${code[2]}`;
      if (!canRead(name, undefined)) return new Response("not found", { status: 404 });
      return new Response(tarball, { status: 200, headers: { "content-type": "application/gzip" } });
    }

    const contents = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/contents\/([^?]+)\?ref=([0-9a-f]{40})$/.exec(url);
    if (contents) {
      const name = `${contents[1]}/${contents[2]}`;
      const path = decodeURIComponent(contents[3] ?? "");
      const text = repos[name]?.files?.[path];
      if (!canRead(name, login) || text === undefined) return Response.json({ message: "Not Found" }, { status: 404 });
      return new Response(text, { status: 200, headers: { "content-type": "application/vnd.github.raw" } });
    }

    const repoUrl = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/?]+)(\/commits\/(.+))?$/.exec(url);
    if (repoUrl) {
      const name = `${repoUrl[1]}/${repoUrl[2]}`;
      const repo = repos[name];
      if (!repo || !canRead(name, login)) return Response.json({ message: "Not Found" }, { status: 404 });
      if (repoUrl[3] === undefined) {
        return Response.json({ default_branch: "main", size: repo.size ?? 12, private: repo.private ?? false });
      }
      return Response.json({ sha: SHA });
    }

    return new Response(`unexpected ${method} ${url}`, { status: 599 });
  };
  return { fetch, calls };
}

/** The sign-in configuration of a deployment with sign-in on (the keys are fixed test values). */
export const SESSION_KEY = Buffer.alloc(32, 7);
export const SIGNING_KEY = Buffer.alloc(32, 9);
export const AUTH_ENV: Record<string, string> = {
  GITHUB_APP_CLIENT_ID: "Iv1.testclient",
  GITHUB_APP_CLIENT_SECRET: "client-secret-value",
  GITHUB_APP_SLUG: "insight-viewer",
  SESSION_SECRET: SESSION_KEY.toString("base64"),
  STORAGE_SIGNING_KEY: SIGNING_KEY.toString("base64"),
  STORAGE_PUBLIC_BASE: "https://storage.test",
  PUBLIC_ORIGIN: "https://insight.test",
};

/** The value of a named cookie among Set-Cookie lines, or undefined. */
export function setCookieValue(lines: string[], name: string): string | undefined {
  for (const line of lines) {
    const head = line.split(";")[0] ?? "";
    if (head.startsWith(`${name}=`)) return head.slice(name.length + 1);
  }
  return undefined;
}
