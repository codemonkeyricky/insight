import { describe, expect, it } from "vitest";
import {
  handleCallback,
  handleLogin,
  handleLogout,
  handleMe,
  handleRepos,
  OAUTH_COOKIE,
  sealValue,
  SESSION_COOKIE,
  type Env,
} from "../src/index.js";
import { AUTH_ENV, fakeApp, SESSION_KEY, setCookieValue } from "./app-helpers.js";
import { makeTarball, NOW } from "./helpers.js";

const ORIGIN = "https://insight.test";
const TARBALL = await makeTarball({ "src/a.ts": "export const a = 1;\n" });

function sessionCookie(payload: Record<string, unknown>): string {
  return `${SESSION_COOKIE}=${sealValue(
    { t: "tok-alice", id: 1, login: "alice", av: "https://avatars.test/alice.png", ...payload },
    SESSION_KEY,
  )}`;
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, { headers });
}

function post(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, { method: "POST", headers });
}

/** Starts a sign-in and returns the OAuth cookie value and the state GitHub would echo back. */
async function beginSignIn(env: Env, ret = "#/gh/acme/widget"): Promise<{ oauth: string; state: string }> {
  const res = await handleLogin(get(`/api/auth/login?return=${encodeURIComponent(ret)}`), env);
  const location = new URL(res.headers.get("location") ?? "");
  return {
    oauth: setCookieValue(res.headers.getSetCookie(), OAUTH_COOKIE) ?? "",
    state: location.searchParams.get("state") ?? "",
  };
}

describe("sign-in: login", () => {
  it("redirects to GitHub's authorize page with the client id, the callback and a state", async () => {
    const res = await handleLogin(get("/api/auth/login?return=%23%2Fgh%2Facme%2Fwidget"), AUTH_ENV);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe(AUTH_ENV.GITHUB_APP_CLIENT_ID);
    expect(location.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback`);
    expect(location.searchParams.get("state")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sets the OAuth state cookie with the hosted flags", async () => {
    const res = await handleLogin(get("/api/auth/login?return=%23%2Fgh%2Facme%2Fwidget"), AUTH_ENV);
    const line = res.headers.getSetCookie().find((c) => c.startsWith(`${OAUTH_COOKIE}=`)) ?? "";
    expect(line).toContain("HttpOnly");
    expect(line).toContain("Secure");
    expect(line).toContain("SameSite=Lax");
    expect(line).toContain("Path=/api/auth");
    expect(line).toContain("Max-Age=600");
  });

  it("falls back to #/ for a return value that is not a hash path", async () => {
    const { oauth, state } = await beginSignIn(AUTH_ENV, "https://evil.test/x");
    const res = await handleCallback(
      get(`/api/auth/callback?code=code-alice&state=${state}`, { cookie: `${OAUTH_COOKIE}=${oauth}` }),
      AUTH_ENV,
      fakeApp({}, TARBALL).fetch,
    );
    expect(res.headers.get("location")).toBe(`${ORIGIN}/#/`);
  });

  it("answers 404 when sign-in is not configured", async () => {
    const res = await handleLogin(get("/api/auth/login"), { GITHUB_APP_CLIENT_ID: "only-the-id" });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });
});

describe("sign-in: callback", () => {
  it("sets insight_session (HttpOnly; Secure; SameSite=Lax), clears the state and returns to the page", async () => {
    const { oauth, state } = await beginSignIn(AUTH_ENV);
    const fake = fakeApp({}, TARBALL);
    const res = await handleCallback(
      get(`/api/auth/callback?code=code-alice&state=${state}`, { cookie: `${OAUTH_COOKIE}=${oauth}` }),
      AUTH_ENV,
      fake.fetch,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/#/gh/acme/widget`);
    const lines = res.headers.getSetCookie();
    const session = lines.find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? "";
    expect(session).toContain("HttpOnly");
    expect(session).toContain("Secure");
    expect(session).toContain("SameSite=Lax");
    expect(session).toContain("Path=/");
    expect(session).toContain("Max-Age=");
    expect(lines.find((c) => c.startsWith(`${OAUTH_COOKIE}=`))).toContain("Max-Age=0");
    expect(fake.calls.some((c) => c.url === "https://github.com/login/oauth/access_token")).toBe(true);
  });

  it("the new session cookie identifies the user", async () => {
    const { oauth, state } = await beginSignIn(AUTH_ENV);
    const res = await handleCallback(
      get(`/api/auth/callback?code=code-alice&state=${state}`, { cookie: `${OAUTH_COOKIE}=${oauth}` }),
      AUTH_ENV,
      fakeApp({}, TARBALL).fetch,
    );
    const session = setCookieValue(res.headers.getSetCookie(), SESSION_COOKIE) ?? "";
    const me = await handleMe(get("/api/auth/me", { cookie: `${SESSION_COOKIE}=${session}` }), AUTH_ENV, fakeApp({}, TARBALL).fetch);
    expect(await me.json()).toMatchObject({ enabled: true, signedIn: true, login: "alice" });
  });

  it("refuses a state that does not match the cookie (302 with auth_error=state)", async () => {
    const { oauth } = await beginSignIn(AUTH_ENV);
    const res = await handleCallback(
      get("/api/auth/callback?code=code-alice&state=" + "0".repeat(64), { cookie: `${OAUTH_COOKIE}=${oauth}` }),
      AUTH_ENV,
      fakeApp({}, TARBALL).fetch,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/#/?auth_error=state`);
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
  });

  it("rejects an expired OAuth state", async () => {
    const pending = sealValue({ state: "a".repeat(64), ret: "#/", exp: NOW - 1 }, SESSION_KEY);
    const res = await handleCallback(
      get(`/api/auth/callback?code=code-alice&state=${"a".repeat(64)}`, { cookie: `${OAUTH_COOKIE}=${pending}` }),
      AUTH_ENV,
      fakeApp({}, TARBALL).fetch,
    );
    expect(res.headers.get("location")).toBe(`${ORIGIN}/#/?auth_error=expired`);
  });

  it("refuses a callback with no OAuth cookie", async () => {
    const res = await handleCallback(get("/api/auth/callback?code=code-alice&state=x"), AUTH_ENV, fakeApp({}, TARBALL).fetch);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/#/?auth_error=state`);
  });

  it("reports a user the user-fetch cannot read as auth_error=user", async () => {
    const { oauth, state } = await beginSignIn(AUTH_ENV);
    const fetchFn = async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/login/oauth/access_token")) return Response.json({ access_token: "tok-alice" });
      return new Response("nope", { status: 500 });
    };
    const res = await handleCallback(
      get(`/api/auth/callback?code=code-alice&state=${state}`, { cookie: `${OAUTH_COOKIE}=${oauth}` }),
      AUTH_ENV,
      fetchFn,
    );
    expect(res.headers.get("location")).toBe(`${ORIGIN}/#/?auth_error=user`);
  });
});

describe("sign-in: the session of a request", () => {
  it("reads a tampered cookie as signed out (not an error)", async () => {
    const value = sealValue({ t: "tok-alice", id: 1, login: "alice", av: "x" }, SESSION_KEY);
    const bytes = Buffer.from(value, "base64url");
    bytes[25] ^= 1;
    const res = await handleMe(get("/api/auth/me", { cookie: `${SESSION_COOKIE}=${bytes.toString("base64url")}` }), AUTH_ENV, fakeApp({}, TARBALL).fetch);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: true, signedIn: false });
  });

  it("refreshes an expired access token with the refresh token, and sets the new cookie", async () => {
    const fake = fakeApp({ "acme/secret": { private: true, readers: ["alice"] } }, TARBALL);
    const expired = sessionCookie({ t: "tok-alice-old", r: "ref-alice", e: NOW - 1000, re: NOW + 86_400_000 });
    const res = await handleRepos(get("/api/private/repos", { cookie: expired }), {
      env: AUTH_ENV,
      fetch: fake.fetch,
      now: () => NOW,
    });
    expect(res.status).toBe(200);
    const refresh = fake.calls.find((c) => c.url === "https://github.com/login/oauth/access_token");
    expect(refresh).toBeDefined();
    const installs = fake.calls.find((c) => c.url.includes("/user/installations?"));
    expect(installs?.auth).toBe("Bearer tok-alice-refreshed");
    const cookie = setCookieValue(res.headers.getSetCookie(), SESSION_COOKIE);
    expect(cookie).toBeDefined();
    expect(cookie).not.toBe(expired.slice(SESSION_COOKIE.length + 1));
  });

  it("signs out when the refresh token is no longer valid", async () => {
    const fake = fakeApp({}, TARBALL);
    const stale = sessionCookie({ t: "tok-alice-old", r: "rejected-token", e: NOW - 1000, re: NOW + 86_400_000 });
    const res = await handleMe(get("/api/auth/me", { cookie: stale }), AUTH_ENV, fake.fetch);
    expect(await res.json()).toMatchObject({ signedIn: false });
  });

  it("signs out when the refresh token has expired too, without calling GitHub", async () => {
    const fake = fakeApp({}, TARBALL);
    const dead = sessionCookie({ t: "tok-alice-old", r: "ref-alice", e: NOW - 1000, re: NOW - 1 });
    const res = await handleMe(get("/api/auth/me", { cookie: dead }), AUTH_ENV, fake.fetch);
    expect(await res.json()).toMatchObject({ signedIn: false });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("sign-out and the origin check", () => {
  it("clears the session with a 204 from the site's origin", async () => {
    const res = await handleLogout(post("/api/auth/logout", { origin: ORIGIN, cookie: sessionCookie({}) }), AUTH_ENV, fakeApp({}, TARBALL).fetch);
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))).toContain("Max-Age=0");
  });

  it("refuses a signed-in logout from another origin with 403 forbidden", async () => {
    const res = await handleLogout(post("/api/auth/logout", { origin: "https://evil.test", cookie: sessionCookie({}) }), AUTH_ENV, fakeApp({}, TARBALL).fetch);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden");
  });

  it("accepts an origin on ALLOWED_ORIGINS", async () => {
    const env = { ...AUTH_ENV, ALLOWED_ORIGINS: "http://localhost:5310, https://preview.test/" };
    const res = await handleLogout(post("/api/auth/logout", { origin: "https://preview.test", cookie: sessionCookie({}) }), env, fakeApp({}, TARBALL).fetch);
    expect(res.status).toBe(204);
  });
});

describe("GET /api/auth/me", () => {
  it("reports a signed-in user and the install link, with no token", async () => {
    const res = await handleMe(get("/api/auth/me", { cookie: sessionCookie({}) }), AUTH_ENV, fakeApp({}, TARBALL).fetch);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toEqual({
      enabled: true,
      signedIn: true,
      login: "alice",
      avatarUrl: "https://avatars.test/alice.png",
      installUrl: "https://github.com/apps/insight-viewer/installations/new",
    });
    expect(JSON.stringify(body)).not.toContain("tok-alice");
  });

  it("reports a signed-out visitor", async () => {
    const res = await handleMe(get("/api/auth/me"), AUTH_ENV, fakeApp({}, TARBALL).fetch);
    expect(await res.json()).toMatchObject({ enabled: true, signedIn: false });
  });

  it("answers 404 when sign-in is off (no env)", async () => {
    const res = await handleMe(get("/api/auth/me"), {}, fakeApp({}, TARBALL).fetch);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  it("treats a SESSION_SECRET of the wrong length as sign-in off", async () => {
    const env = { ...AUTH_ENV, SESSION_SECRET: Buffer.alloc(16).toString("base64") };
    const res = await handleMe(get("/api/auth/me"), env, fakeApp({}, TARBALL).fetch);
    expect(res.status).toBe(404);
  });
});
