// Object storage for the hosted indexes: a Cloudflare R2 bucket in production (S3 API, signed with aws4fetch) and a
// local folder for development and tests. Both store the same keys, and both write the headers the public read needs.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { AwsV4Signer } from "aws4fetch";

export interface PutOptions {
  contentType: string;
  cacheControl: string;
  /** Gzip the body and mark it Content-Encoding: gzip. */
  gzip?: boolean;
}

export interface Storage {
  readonly kind: "r2" | "fs";
  put(key: string, body: string, opts: PutOptions): Promise<void>;
  /** The decoded text, or undefined when the key does not exist. */
  get(key: string): Promise<string | undefined>;
  getJson<T = unknown>(key: string): Promise<T | undefined>;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

/** The text of a stored body, gunzipped when it still carries the gzip magic (a fetch may already have decoded it). */
function decodeBody(bytes: Uint8Array): string {
  const isGzip = bytes.length >= 2 && bytes[0] === GZIP_MAGIC_0 && bytes[1] === GZIP_MAGIC_1;
  return Buffer.from(isGzip ? gunzipSync(bytes) : bytes).toString("utf8");
}

async function parseJson<T>(text: string | undefined): Promise<T | undefined> {
  return text === undefined ? undefined : (JSON.parse(text) as T);
}

interface Sidecar {
  contentType: string;
  cacheControl: string;
  contentEncoding?: string;
}

/** A folder on disk. Each key is a file; its headers go in `<key>.meta.json` beside it. */
export function fsStorage(dir: string): Storage {
  const pathFor = (key: string): string => {
    if (key.split("/").some((part) => part === "" || part === "..")) throw new Error(`bad storage key: ${key}`);
    return join(dir, ...key.split("/"));
  };
  return {
    kind: "fs",
    async put(key, body, opts) {
      const file = pathFor(key);
      await mkdir(dirname(file), { recursive: true });
      const bytes = opts.gzip ? gzipSync(Buffer.from(body, "utf8")) : Buffer.from(body, "utf8");
      await writeFile(file, bytes);
      const sidecar: Sidecar = {
        contentType: opts.contentType,
        cacheControl: opts.cacheControl,
        ...(opts.gzip ? { contentEncoding: "gzip" } : {}),
      };
      await writeFile(`${file}.meta.json`, JSON.stringify(sidecar));
    },
    async get(key) {
      try {
        return decodeBody(new Uint8Array(await readFile(pathFor(key))));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw err;
      }
    },
    async getJson<T>(key: string) {
      return parseJson<T>(await this.get(key));
    },
  };
}

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  fetch?: FetchLike;
}

/** Keys keep their slashes; each segment is percent-encoded (an "@" stays readable). */
function encodeKey(key: string): string {
  return key
    .split("/")
    .map((seg) => encodeURIComponent(seg).replace(/%40/g, "@"))
    .join("/");
}

/** The Cloudflare R2 bucket, through its S3 API. Requests are signed with SigV4 (region "auto"). */
export function r2Storage(config: R2Config): Storage {
  const fetchFn: FetchLike = config.fetch ?? ((input, init) => fetch(input, init));
  const base = `https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}`;
  /** The request for `url`, signed with SigV4 (the S3 API, region "auto"). */
  const signed = async (url: string, init: { method: string; headers?: Record<string, string>; body?: Uint8Array }) => {
    const out = await new AwsV4Signer({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: "s3",
      region: "auto",
    }).sign();
    return new Request(out.url, { method: out.method, headers: out.headers, body: out.body ?? undefined });
  };

  return {
    kind: "r2",
    async put(key, body, opts) {
      const payload = opts.gzip ? gzipSync(Buffer.from(body, "utf8")) : Buffer.from(body, "utf8");
      const headers: Record<string, string> = {
        "content-type": opts.contentType,
        "cache-control": opts.cacheControl,
      };
      if (opts.gzip) headers["content-encoding"] = "gzip";
      const url = `${base}/${encodeKey(key)}`;
      const req = await signed(url, { method: "PUT", headers, body: new Uint8Array(payload) });
      const res = await fetchFn(req);
      if (!res.ok) throw new Error(`R2 PUT ${key} failed: ${res.status} ${await res.text()}`);
    },
    async get(key) {
      const url = `${base}/${encodeKey(key)}`;
      const req = await signed(url, { method: "GET" });
      const res = await fetchFn(req);
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error(`R2 GET ${key} failed: ${res.status}`);
      return decodeBody(new Uint8Array(await res.arrayBuffer()));
    },
    async getJson<T>(key: string) {
      return parseJson<T>(await this.get(key));
    },
  };
}
