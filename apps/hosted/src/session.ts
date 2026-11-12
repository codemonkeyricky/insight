// Sealed cookies for the hosted sign-in: AES-256-GCM over a JSON payload (the session, and the OAuth state of a sign-in in
// progress), with the cookie helpers. A value that does not open (tampered, wrong key, malformed) reads as absent.
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "insight_session";
export const OAUTH_COOKIE = "insight_oauth";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** A 32-byte key from its base64 text, or undefined when the text is not 32 bytes. */
export function parseKey(base64: string): Buffer | undefined {
  const key = Buffer.from(base64.trim(), "base64");
  return key.length === 32 ? key : undefined;
}

/** iv (12 bytes) || AES-256-GCM ciphertext || tag (16 bytes), base64url. */
export function sealValue(payload: unknown, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
}

/** The payload of a sealed value, or undefined when it does not open. Never throws. */
export function openValue<T>(sealed: string, key: Buffer): T | undefined {
  try {
    const bytes = Buffer.from(sealed, "base64url");
    if (bytes.length < IV_BYTES + TAG_BYTES) return undefined;
    const iv = bytes.subarray(0, IV_BYTES);
    const tag = bytes.subarray(bytes.length - TAG_BYTES);
    const body = bytes.subarray(IV_BYTES, bytes.length - TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    const text = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** The value of the named cookie in a Cookie header, or undefined. */
export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** A Set-Cookie line with the hosted flags: HttpOnly, Secure, SameSite=Lax. */
export function serializeCookie(name: string, value: string, opts: { maxAge: number; path: string }): string {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=${opts.path}; Max-Age=${opts.maxAge}`;
}

/** A Set-Cookie line that removes the cookie. */
export function clearCookie(name: string, path: string): string {
  return serializeCookie(name, "", { maxAge: 0, path });
}

/** String equality in time that depends only on the lengths. */
export function timingEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}
