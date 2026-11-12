import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { clearCookie, openValue, parseKey, readCookie, sealValue, serializeCookie, timingEqual } from "../src/index.js";

const KEY = randomBytes(32);

describe("sealed values", () => {
  it("round-trips a payload with the same key", () => {
    const sealed = sealValue({ t: "tok-alice", id: 1, login: "alice" }, KEY);
    expect(openValue(sealed, KEY)).toEqual({ t: "tok-alice", id: 1, login: "alice" });
  });

  it("does not show the plaintext in the sealed text", () => {
    const sealed = sealValue({ t: "tok-alice-secret-token" }, KEY);
    expect(sealed).not.toContain("tok-alice");
    expect(Buffer.from(sealed, "base64url").toString("utf8")).not.toContain("tok-alice");
  });

  it("uses a fresh IV, so two seals of one payload differ", () => {
    expect(sealValue({ a: 1 }, KEY)).not.toBe(sealValue({ a: 1 }, KEY));
  });

  it("reads a tampered cookie as absent (no throw)", () => {
    const bytes = Buffer.from(sealValue({ t: "tok-alice" }, KEY), "base64url");
    bytes[20] ^= 1;
    expect(openValue(bytes.toString("base64url"), KEY)).toBeUndefined();
  });

  it("reads a value sealed with another key as absent", () => {
    const other = randomBytes(32);
    expect(openValue(sealValue({ t: "x" }, other), KEY)).toBeUndefined();
  });

  it("reads junk and short values as absent", () => {
    expect(openValue("", KEY)).toBeUndefined();
    expect(openValue("not-a-cookie!!", KEY)).toBeUndefined();
    expect(openValue("abc", KEY)).toBeUndefined();
  });

  it("accepts only 32-byte keys", () => {
    expect(parseKey(randomBytes(32).toString("base64"))).toHaveLength(32);
    expect(parseKey(randomBytes(16).toString("base64"))).toBeUndefined();
    expect(parseKey("")).toBeUndefined();
  });
});

describe("cookies", () => {
  it("reads one named cookie from a Cookie header", () => {
    expect(readCookie("a=1; insight_session=xyz; b=2", "insight_session")).toBe("xyz");
    expect(readCookie("a=1", "insight_session")).toBeUndefined();
    expect(readCookie(null, "insight_session")).toBeUndefined();
  });

  it("serializes with the hosted flags", () => {
    expect(serializeCookie("insight_session", "v", { maxAge: 60, path: "/" })).toBe(
      "insight_session=v; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=60",
    );
    expect(clearCookie("insight_oauth", "/api/auth")).toBe("insight_oauth=; HttpOnly; Secure; SameSite=Lax; Path=/api/auth; Max-Age=0");
  });

  it("compares strings in constant time (equal, different, different length)", () => {
    expect(timingEqual("abc", "abc")).toBe(true);
    expect(timingEqual("abc", "abd")).toBe(false);
    expect(timingEqual("abc", "abcd")).toBe(false);
  });
});
