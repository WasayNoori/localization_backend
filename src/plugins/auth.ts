import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { env } from "../config/env.js";

export const auth = fp(async (app: FastifyInstance) => {
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const apiKey = request.headers["x-api-key"];

    if (apiKey !== env.API_KEY) {
      reply.code(401).send({ error: "Unauthorized" });
    }
  });
});
