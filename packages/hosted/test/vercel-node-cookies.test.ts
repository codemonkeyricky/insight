import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { errorResponse, withCookies } from "../src/http.js";
import { requestOrigin, sendWebResponse, toWebRequest } from "../src/vercel-node.js";

let server: Server;
let origin = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/cookies") {
      const res2 = withCookies(new Response("ok", { status: 200 }), ["insight_session=one; Path=/", "insight_oauth=; Path=/api/auth; Max-Age=0"]);
      void sendWebResponse(res, res2);
      return;
    }
    if (req.url === "/refused") {
      void sendWebResponse(res, withCookies(errorResponse(403, "forbidden", "no"), "insight_session=two; Path=/"));
      return;
    }
    void toWebRequest(req).then(async (request) => {
      await sendWebResponse(res, Response.json({ url: request.url }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => {
  server.close();
});

describe("node adapter: Set-Cookie", () => {
  it("writes each Set-Cookie on its own line, so both reach the browser", async () => {
    const res = await fetch(`${origin}/cookies`);
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual(["insight_session=one; Path=/", "insight_oauth=; Path=/api/auth; Max-Age=0"]);
    expect(await res.text()).toBe("ok");
  });

  it("keeps a refreshed cookie on an error response", async () => {
    const res = await fetch(`${origin}/refused`);
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toEqual(["insight_session=two; Path=/"]);
  });
});

describe("node adapter: the request URL", () => {
  it("builds the URL from x-forwarded-host and x-forwarded-proto", async () => {
    const res = await fetch(`${origin}/x?y=1`, { headers: { "x-forwarded-host": "arch-insight.vercel.app", "x-forwarded-proto": "https" } });
    expect(await res.json()).toEqual({ url: "https://arch-insight.vercel.app/x?y=1" });
  });

  it("uses the host header with a loopback http origin when no forwarded headers are sent", async () => {
    const res = await fetch(`${origin}/z`);
    const body = (await res.json()) as { url: string };
    expect(body.url).toBe(`${origin}/z`);
  });
});

it("requestOrigin falls back to the function's own origin when no host is sent", () => {
  const req = { headers: {} } as unknown as import("node:http").IncomingMessage;
  expect(requestOrigin(req)).toBe("https://insight.vercel.app");
});
