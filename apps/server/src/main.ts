#!/usr/bin/env node
import { buildServer } from "./app.js";

const port = Number(process.env.PORT ?? 4317);
const host = process.env.HOST ?? "127.0.0.1";

const server = await buildServer();
await server.app.listen({ port, host });
console.log(`Insight server on http://${host}:${port}  (home: ${server.registry.home})`);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void server.close().then(() => process.exit(0));
  });
}
