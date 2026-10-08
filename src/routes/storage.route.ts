// src/routes/storage.route.ts
import type { FastifyInstance } from "fastify";

export async function storageRoute(app: FastifyInstance) {
  app.get(
    "/storage/box/status",
    {
      schema: {
        description:
          "Box connectivity check: signs in (the Box app's client-credentials login, or a developer token for " +
          "testing) and returns the account it acts as. That account's login (email) must be a collaborator " +
          "(Editor) on each course's Box folder. 502 with Box's message when sign-in fails.",
        security: [{ apiKey: [] }],
      },
    },
    async (request, reply) => {
      try {
        return { connected: true, account: await app.fileStorageService.whoAmI() };
      } catch (err) {
        request.log.warn(err, "Box status check failed");
        return reply.code(502).send({ error: "BoxUnavailable", message: err instanceof Error ? err.message : String(err) });
      }
    }
  );
}
