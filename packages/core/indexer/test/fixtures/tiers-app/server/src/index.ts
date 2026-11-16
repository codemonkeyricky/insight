import Fastify from "fastify";
import { openDb } from "./db.js";

const app = Fastify({ logger: false });
const db = openDb();

app.get("/api/items", async () => db.prepare("select id, title from items").all());

app.get("/api/items/:id/detail", async (req) => {
  const { id } = req.params as { id: string };
  return db.prepare("select id, title from items where id = ?").get(id) ?? null;
});

app.get("/api/items/:id/events", (req, reply) => {
  const { id } = req.params as { id: string };
  reply.raw.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
  reply.raw.write(`data: ${JSON.stringify({ id, ready: true })}\n\n`);
});

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "127.0.0.1" });
