import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

export const auth = fp(async (app: FastifyInstance) => {
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url.startsWith("/docs")) {
      return;
    }

    const apiKey = request.headers["x-api-key"];

    if (apiKey !== app.secrets.apiKey) {
      reply.code(401).send({ error: "Unauthorized" });
    }
  });
});
