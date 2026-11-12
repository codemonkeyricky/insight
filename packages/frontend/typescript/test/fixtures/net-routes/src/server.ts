import Fastify from "fastify";

const app = Fastify();

async function reindex(req: unknown) {
  return req;
}

export function register() {
  app.post("/api/projects/:id/reindex", reindex);
}

app.route({ method: "GET", url: "/x", handler: async () => "ok" });
