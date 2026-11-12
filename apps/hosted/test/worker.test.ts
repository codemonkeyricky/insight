import { describe, expect, it } from "vitest";
import worker from "../../storage-worker/index.js";
import { handleGrant, signPrefix } from "../src/index.js";
import { AUTH_ENV, fakeApp, SESSION_KEY, SIGNING_KEY, type AppRepo } from "./app-helpers.js";
import { FIXTURE, makeTarball, NOW, SHA } from "./helpers.js";
import { sealValue, SESSION_COOKIE } from "../src/index.js";

const SECRET = SIGNING_KEY.toString("base64");
const BASE = "https://storage.test";
const SHA2 = "fedcba9876543210fedcba9876543210fedcba98";
const NOW_S = Math.floor(Date.now() / 1000);
const enc = new TextEncoder();

/** A fake of the KV binding: key → text, with the metadata the Worker serves as headers. */
function fakeEnv(entries: Record<string, string>, secret: string | null = SECRET) {
  const store = new Map(Object.entries(entries));
  const env = {
    INDEX: {
      async getWithMetadata(key: string) {
        const text = store.get(key);
        if (text === undefined) return { value: null, metadata: null };
        return {
          value: enc.encode(text).buffer,
          metadata: { contentType: "application/json", cacheControl: "public, max-age=60" },
        };
      },
    },
    STORAGE_SIGNING_KEY: secret,
  };
  return env as unknown as Parameters<typeof worker.fetch>[1];
}

function get(path: string): Request {
  return new Request(`${BASE}${path}`);
}

const PRIVATE_KEY = `private/gh/acme/secret/${SHA}/status.json`;
const PREFIX = `private/gh/acme/secret/${SHA}/`;
const CONTENT = { [PRIVATE_KEY]: '{"state":"done"}', [`gh/acme/open/${SHA}/model.json`]: '{"nodes":[]}' };

describe("storage Worker: private keys", () => {
  it("answers 404 for an unsigned private key", async () => {
    const res = await worker.fetch(get(`/${PRIVATE_KEY}`), fakeEnv(CONTENT));
    expect(res.status).toBe(404);
  });

  it("serves a validly signed private key with the private cache header", async () => {
    const exp = NOW_S + 3600;
    const sig = signPrefix(SIGNING_KEY, exp, PREFIX);
    const res = await worker.fetch(get(`/p/${exp}/${sig}/${PRIVATE_KEY}`), fakeEnv(CONTENT));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.text()).toBe('{"state":"done"}');
  });

  it("answers 404 for an expired signature", async () => {
    const exp = NOW_S - 10;
    const sig = signPrefix(SIGNING_KEY, exp, PREFIX);
    const res = await worker.fetch(get(`/p/${exp}/${sig}/${PRIVATE_KEY}`), fakeEnv(CONTENT));
    expect(res.status).toBe(404);
  });

  it("answers 404 for a signature made for another commit's prefix", async () => {
    const exp = NOW_S + 3600;
    const sig = signPrefix(SIGNING_KEY, exp, `private/gh/acme/secret/${SHA2}/`);
    const res = await worker.fetch(get(`/p/${exp}/${sig}/${PRIVATE_KEY}`), fakeEnv(CONTENT));
    expect(res.status).toBe(404);
  });

  it("answers 404 for a '..' in the signed key (an encoded slash reaches the Worker)", async () => {
    const exp = NOW_S + 3600;
    const sig = signPrefix(SIGNING_KEY, exp, PREFIX);
    const res = await worker.fetch(get(`/p/${exp}/${sig}/${PREFIX}%2F..%2Fstatus.json`), fakeEnv({ ...CONTENT, "private/gh/acme/secret/status.json": "x" }));
    expect(res.status).toBe(404);
  });

  it("answers 404 for a signature that is not the HMAC of the prefix", async () => {
    const exp = NOW_S + 3600;
    const res = await worker.fetch(get(`/p/${exp}/AAAA/${PRIVATE_KEY}`), fakeEnv(CONTENT));
    expect(res.status).toBe(404);
  });

  it("answers 404 for every private request when no signing secret is configured", async () => {
    const exp = NOW_S + 3600;
    const sig = signPrefix(SIGNING_KEY, exp, PREFIX);
    expect((await worker.fetch(get(`/p/${exp}/${sig}/${PRIVATE_KEY}`), fakeEnv(CONTENT, null))).status).toBe(404);
    expect((await worker.fetch(get(`/${PRIVATE_KEY}`), fakeEnv(CONTENT, null))).status).toBe(404);
  });

  it("answers 404 for a malformed signing secret", async () => {
    const exp = NOW_S + 3600;
    const sig = signPrefix(SIGNING_KEY, exp, PREFIX);
    const res = await worker.fetch(get(`/p/${exp}/${sig}/${PRIVATE_KEY}`), fakeEnv(CONTENT, "not-32-bytes"));
    expect(res.status).toBe(404);
  });
});

describe("storage Worker: public keys", () => {
  it("serves a public key as before, with its stored cache header", async () => {
    const res = await worker.fetch(get(`/gh/acme/open/${SHA}/model.json`), fakeEnv(CONTENT));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(await res.text()).toBe('{"nodes":[]}');
  });

  it("answers 404 for a missing public key and for '..'", async () => {
    expect((await worker.fetch(get("/gh/acme/open/missing.json"), fakeEnv(CONTENT))).status).toBe(404);
    expect((await worker.fetch(get("/gh/%2E%2E/x"), fakeEnv(CONTENT))).status).toBe(404);
  });

  it("answers 404 for an unsigned p/ path that is not a signed shape", async () => {
    expect((await worker.fetch(get("/p/notanumber/sig/gh/x"), fakeEnv(CONTENT))).status).toBe(404);
  });
});

describe("storage Worker: the grant from the API is accepted", () => {
  it("serves the files under a grant's base, and nothing else", async () => {
    const tarball = await makeTarball(FIXTURE);
    const fake = fakeApp({ "acme/secret": { private: true, readers: ["alice"] } as AppRepo }, tarball);
    const session = `${SESSION_COOKIE}=${sealValue({ t: "tok-alice", id: 1, login: "alice", av: "x", e: Date.now() + 3_600_000 }, SESSION_KEY)}`;
    const grant = await handleGrant(
      new Request(`https://insight.test/api/private/grant?repo=acme/secret&sha=${SHA}`, { headers: { cookie: session } }),
      { env: AUTH_ENV, fetch: fake.fetch, now: () => Date.now() },
    );
    expect(grant.status).toBe(200);
    const { base } = (await grant.json()) as { base: string };
    const env = fakeEnv({ [PRIVATE_KEY]: '{"state":"done"}' }, SECRET);
    const ok = await worker.fetch(new Request(`${base}status.json`), env);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('{"state":"done"}');
    const other = await worker.fetch(new Request(`${base.replace(SHA, SHA2)}status.json`), env);
    expect(other.status).toBe(404);
  });
});

void SHA;
void NOW;
