// The Vercel Function entry: POST runs /api/index, GET runs /api/health. The job runs in waitUntil, so the response
// returns at once (202) and the function keeps running until the job finishes or the watchdog fires.
import { waitUntil } from "@vercel/functions";
import { buildDeps, storageFromEnv } from "./env.js";
import { handleHealth, handleIndex } from "./indexer.js";

export async function POST(request: Request): Promise<Response> {
  try {
    return await handleIndex(request, buildDeps(process.env, { waitUntil }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: { code: "index_failed", message } }, { status: 500 });
  }
}

export async function GET(): Promise<Response> {
  try {
    return handleHealth({ storage: storageFromEnv(process.env) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
