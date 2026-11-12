// Response helpers shared by the hosted handlers: JSON bodies, coded errors, and cookies added to a response.
export const NO_STORE = "no-store";

export function json(status: number, body: unknown, cacheControl = NO_STORE): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": cacheControl },
  });
}

/** A coded error: {error: {code, message, ...extra}}. */
export function errorResponse(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  return json(status, { error: { code, message, ...extra } });
}

/**
 * The response with each Set-Cookie added. Node's headers object would merge repeated Set-Cookie lines, so every cookie
 * is appended on its own. With no cookies the response is returned as it is.
 */
export function withCookies(res: Response, cookies: string | string[] | undefined): Response {
  if (cookies === undefined) return res;
  const list = Array.isArray(cookies) ? cookies : [cookies];
  if (list.length === 0) return res;
  const headers = new Headers(res.headers);
  for (const cookie of list) headers.append("set-cookie", cookie);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
