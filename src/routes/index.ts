import type { FastifyInstance } from "fastify";

export async function routes(app: FastifyInstance) {
  app.get("/health", async () => ({ status: "ok" }));
}
