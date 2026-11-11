// GitHub App user OAuth for the hosted site: sign-in (login), the callback, sign-out, the session of a request (refreshed
// when its access token has expired), the origin check for state-changing requests, and the access gates that private
// reads use. Sign-in is off unless GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET and SESSION_SECRET are all set.
import { randomBytes } from "node:crypto";
import { NotFoundError, repoInfo, UpstreamError } from "./github.js";
import { errorResponse, json, NO_STORE, withCookies } from "./http.js";
import {
  clearCookie,
  OAUTH_COOKIE,
  openValue,
  parseKey,
  readCookie,
  SESSION_COOKIE,
  sealValue,
  serializeCookie,
  timingEqual,
} from "./session.js";
import type { FetchLike } from "./storage.js";

export type Env = Record<string, string | undefined>;

const GITHUB = "https://github.com";
const API = "https://api.github.com";
const USER_AGENT = "insight-indexer";
const OAUTH_PATH = "/api/auth";
const DEFAULT_SESSION_MAX_AGE_S = 8 * 60 * 60;
const OAUTH_LIFE_MS = 10 * 60 * 1000;
const RETURN_PATH = /^#\/[A-Za-z0-9/_~.@?=&%-]*$/;
export const DISABLED_MESSAGE = "sign-in is not configured";

export interface AuthConfig {
  clientId: string;
  clientSecret: string;
  key: Buffer;
  slug?: string;
  publicOrigin?: string;
  allowedOrigins: string[];
}

function cleanOrigin(text: string | undefined): string | undefined {
  const value = text?.trim().replace(/\/+$/, "");
  return value ? value : undefined;
}

/**
 * The sign-in configuration, or undefined when sign-in is off. A SESSION_SECRET that is not 32 bytes also turns sign-in
 * off (the public indexer keeps working) rather than failing every request.
 */
export function authConfigFromEnv(env: Env): AuthConfig | undefined {
  const clientId = env.GITHUB_APP_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET?.trim();
  const secret = env.SESSION_SECRET?.trim();
  if (!clientId || !clientSecret || !secret) return undefined;
  const key = parseKey(secret);
  if (key === undefined) return undefined;
  return {
    clientId,
    clientSecret,
    key,
    slug: env.GITHUB_APP_SLUG?.trim() || undefined,
    publicOrigin: cleanOrigin(env.PUBLIC_ORIGIN),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => cleanOrigin(origin))
      .filter((origin): origin is string => origin !== undefined),
  };
}

/** The site's origin: PUBLIC_ORIGIN when set, else the origin of the request. */
export function publicOriginOf(config: AuthConfig, request: Request): string {
  return config.publicOrigin ?? new URL(request.url).origin;
}

/** The GitHub page where the signed-in user installs the app, or undefined without GITHUB_APP_SLUG. */
export function installUrlOf(config: AuthConfig): string | undefined {
  return config.slug ? `${GITHUB}/apps/${config.slug}/installations/new` : undefined;
}

/** True when the request's Origin is the site's origin or on ALLOWED_ORIGINS. A missing Origin is refused. */
export function originAllowed(request: Request, config: AuthConfig): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  return origin === publicOriginOf(config, request) || config.allowedOrigins.includes(origin);
}

/** The signed-in user of a request, with the Set-Cookie to send back when the session was refreshed. */
export interface Session {
  token: string;
  user: { id: number; login: string; avatarUrl: string };
  setCookie?: string;
}

/** The session payload, sealed in insight_session. Field names are short on purpose (cookie size). */
interface SessionPayload {
  t: string;
  r?: string;
  e?: number;
  re?: number;
  id: number;
  login: string;
  av: string;
}

interface OAuthState {
  state: string;
  ret: string;
  exp: number;
}

interface TokenSet {
  access: string;
  refresh?: string;
  expiresAt?: number;
  refreshExpiresAt?: number;
}

function isSessionPayload(value: unknown): value is SessionPayload {
  const v = value as Partial<SessionPayload> | null;
  return !!v && typeof v.t === "string" && typeof v.id === "number" && typeof v.login === "string" && typeof v.av === "string";
}

function isOAuthState(value: unknown): value is OAuthState {
  const v = value as Partial<OAuthState> | null;
  return !!v && typeof v.state === "string" && typeof v.ret === "string" && typeof v.exp === "number";
}

function sessionOf(payload: SessionPayload): Session {
  return { token: payload.t, user: { id: payload.id, login: payload.login, avatarUrl: payload.av } };
}

/** The insight_session Set-Cookie for a payload. Max-Age is the refresh token's lifetime, else 8 hours. */
function sessionCookie(config: AuthConfig, payload: SessionPayload, now: number): string {
  const maxAge =
    payload.re !== undefined ? Math.max(0, Math.floor((payload.re - now) / 1000)) : DEFAULT_SESSION_MAX_AGE_S;
  return serializeCookie(SESSION_COOKIE, sealValue(payload, config.key), { maxAge, path: "/" });
}

/** POST to GitHub's token endpoint. Undefined when GitHub refuses (no access_token in the answer) or fails. */
async function tokenRequest(
  config: AuthConfig,
  fetchFn: FetchLike,
  params: Record<string, string>,
  now: number,
): Promise<TokenSet | undefined> {
  try {
    const body = new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...params });
    const res = await fetchFn(`${GITHUB}/login/oauth/access_token`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: body.toString(),
    });
    if (!res.ok) return undefined;
    const answer = (await res.json()) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
      refresh_token_expires_in?: unknown;
    };
    if (typeof answer.access_token !== "string") return undefined;
    const life = (seconds: unknown): number | undefined =>
      typeof seconds === "number" && seconds > 0 ? now + seconds * 1000 : undefined;
    return {
      access: answer.access_token,
      refresh: typeof answer.refresh_token === "string" ? answer.refresh_token : undefined,
      expiresAt: life(answer.expires_in),
      refreshExpiresAt: life(answer.refresh_token_expires_in),
    };
  } catch {
    return undefined;
  }
}

async function fetchUser(token: string, fetchFn: FetchLike): Promise<{ id: number; login: string; avatar_url: string } | undefined> {
  try {
    const res = await fetchFn(`${API}/user`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT },
    });
    if (!res.ok) return undefined;
    const user = (await res.json()) as { id?: unknown; login?: unknown; avatar_url?: unknown };
    if (typeof user.id !== "number" || typeof user.login !== "string") return undefined;
    return { id: user.id, login: user.login, avatar_url: typeof user.avatar_url === "string" ? user.avatar_url : "" };
  } catch {
    return undefined;
  }
}

/**
 * The signed-in user of a request, or undefined (signed out, a bad or tampered cookie, a session that cannot be
 * refreshed, or sign-in off). When the access token has expired and the refresh token is still valid, the token is
 * refreshed and the result carries the new insight_session cookie.
 */
export async function sessionFrom(request: Request, env: Env, fetchFn: FetchLike): Promise<Session | undefined> {
  const config = authConfigFromEnv(env);
  if (!config) return undefined;
  const sealed = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (sealed === undefined) return undefined;
  const payload = openValue<SessionPayload>(sealed, config.key);
  if (!isSessionPayload(payload)) return undefined;

  const now = Date.now();
  if (payload.e === undefined || now < payload.e) return sessionOf(payload);
  if (payload.r === undefined || (payload.re !== undefined && now >= payload.re)) return undefined;
  const tokens = await tokenRequest(config, fetchFn, { grant_type: "refresh_token", refresh_token: payload.r }, now);
  if (tokens === undefined) return undefined;
  const refreshed: SessionPayload = {
    ...payload,
    t: tokens.access,
    e: tokens.expiresAt,
    r: tokens.refresh ?? payload.r,
    re: tokens.refreshExpiresAt ?? payload.re,
  };
  return { ...sessionOf(refreshed), setCookie: sessionCookie(config, refreshed, now) };
}

function disabled(): Response {
  return errorResponse(404, "not_found", DISABLED_MESSAGE);
}

function redirect(location: string, cookies: string[]): Response {
  return withCookies(new Response(null, { status: 302, headers: { location, "cache-control": NO_STORE } }), cookies);
}

/** A return path from the login URL: "#/" followed by a safe set of characters, else the home page. */
function returnPath(raw: string | null): string {
  return raw !== null && RETURN_PATH.test(raw) ? raw : "#/";
}

/** GET /api/auth/login?return=<hash>: sets the OAuth state cookie and redirects to GitHub's authorize page. */
export async function handleLogin(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return errorResponse(405, "method_not_allowed", "use GET");
  const config = authConfigFromEnv(env);
  if (!config) return disabled();
  const origin = publicOriginOf(config, request);
  const state = randomBytes(32).toString("hex");
  const authorize = new URL(`${GITHUB}/login/oauth/authorize`);
  authorize.searchParams.set("client_id", config.clientId);
  authorize.searchParams.set("redirect_uri", `${origin}/api/auth/callback`);
  authorize.searchParams.set("state", state);
  const pending: OAuthState = {
    state,
    ret: returnPath(new URL(request.url).searchParams.get("return")),
    exp: Date.now() + OAUTH_LIFE_MS,
  };
  const cookie = serializeCookie(OAUTH_COOKIE, sealValue(pending, config.key), {
    maxAge: OAUTH_LIFE_MS / 1000,
    path: OAUTH_PATH,
  });
  return redirect(authorize.href, [cookie]);
}

/**
 * GET /api/auth/callback?code&state: checks the state (cookie, in constant time, and its expiry), exchanges the code,
 * reads the user, sets insight_session and returns to the page the sign-in began on. Any failure returns to the home
 * page with ?auth_error=<code>.
 */
export async function handleCallback(request: Request, env: Env, fetchFn: FetchLike): Promise<Response> {
  if (request.method !== "GET") return errorResponse(405, "method_not_allowed", "use GET");
  const config = authConfigFromEnv(env);
  if (!config) return disabled();
  const origin = publicOriginOf(config, request);
  const fail = (code: string): Response => redirect(`${origin}/#/?auth_error=${code}`, [clearCookie(OAUTH_COOKIE, OAUTH_PATH)]);

  const pending = openValue<OAuthState>(readCookie(request.headers.get("cookie"), OAUTH_COOKIE) ?? "", config.key);
  if (!isOAuthState(pending)) return fail("state");
  if (Date.now() > pending.exp) return fail("expired");
  const url = new URL(request.url);
  if (!timingEqual(url.searchParams.get("state") ?? "", pending.state)) return fail("state");
  const githubError = url.searchParams.get("error");
  if (githubError !== null) return fail(githubError === "access_denied" ? "access_denied" : "github");
  const code = url.searchParams.get("code");
  if (!code) return fail("github");

  const now = Date.now();
  const tokens = await tokenRequest(config, fetchFn, { code, redirect_uri: `${origin}/api/auth/callback` }, now);
  if (tokens === undefined) return fail("github");
  const user = await fetchUser(tokens.access, fetchFn);
  if (user === undefined) return fail("user");
  const payload: SessionPayload = {
    t: tokens.access,
    r: tokens.refresh,
    e: tokens.expiresAt,
    re: tokens.refreshExpiresAt,
    id: user.id,
    login: user.login,
    av: user.avatar_url,
  };
  return redirect(`${origin}/${pending.ret}`, [sessionCookie(config, payload, now), clearCookie(OAUTH_COOKIE, OAUTH_PATH)]);
}

/** POST /api/auth/logout: clears the session cookie (204). A signed-in request must come from an allowed origin. */
export async function handleLogout(request: Request, env: Env, fetchFn: FetchLike): Promise<Response> {
  if (request.method !== "POST") return errorResponse(405, "method_not_allowed", "use POST");
  const config = authConfigFromEnv(env);
  if (!config) return disabled();
  const session = await sessionFrom(request, env, fetchFn);
  if (session !== undefined && !originAllowed(request, config)) {
    return errorResponse(403, "forbidden", "this request must come from the Insight site");
  }
  return withCookies(new Response(null, { status: 204, headers: { "cache-control": NO_STORE } }), [clearCookie(SESSION_COOKIE, "/")]);
}

/** GET /api/auth/me: whether sign-in is on for this request and who is signed in. Never cached. */
export async function handleMe(request: Request, env: Env, fetchFn: FetchLike): Promise<Response> {
  if (request.method !== "GET") return errorResponse(405, "method_not_allowed", "use GET");
  const config = authConfigFromEnv(env);
  if (!config) return disabled();
  const session = await sessionFrom(request, env, fetchFn);
  const installUrl = installUrlOf(config);
  const body = session
    ? { enabled: true, signedIn: true, login: session.user.login, avatarUrl: session.user.avatarUrl, installUrl }
    : { enabled: true, signedIn: false, installUrl };
  return withCookies(json(200, body), session?.setCookie);
}

/** The session the request needs: 404 when sign-in is off, 401 auth_required when signed out. */
export async function requireSession(request: Request, env: Env, fetchFn: FetchLike): Promise<Session | Response> {
  if (!authConfigFromEnv(env)) return disabled();
  const session = await sessionFrom(request, env, fetchFn);
  if (session === undefined) return errorResponse(401, "auth_required", "sign in with GitHub first");
  return session;
}

/**
 * requireSession, then GitHub's own check that the signed-in user can read the repository (private ones included, through
 * the app's installation). Not visible to the user: 404 not_found, with the install link.
 */
export async function requireAccess(
  request: Request,
  env: Env,
  fetchFn: FetchLike,
  owner: string,
  repo: string,
): Promise<Session | Response> {
  const session = await requireSession(request, env, fetchFn);
  if (session instanceof Response) return session;
  const config = authConfigFromEnv(env);
  const withSession = (res: Response): Response => withCookies(res, session.setCookie);
  try {
    await repoInfo(owner, repo, { fetch: fetchFn, token: session.token, allowPrivate: true });
  } catch (err) {
    if (err instanceof NotFoundError) {
      return withSession(
        errorResponse(404, "not_found", `${owner}/${repo} was not found, or the Insight app is not installed on it`, {
          installUrl: config ? installUrlOf(config) : undefined,
        }),
      );
    }
    if (err instanceof UpstreamError) return withSession(errorResponse(502, "upstream_error", err.message));
    throw err;
  }
  return session;
}
