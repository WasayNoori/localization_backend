// src/routes/jobs.route.ts
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { processingJobs } from "../db/schema.js";

export async function jobsRoute(app: FastifyInstance) {
  app.get(
    "/jobs/:jobId",
    {
      schema: {
        security: [{ apiKey: [] }],
        params: {
          type: "object",
          required: ["jobId"],
          properties: {
            jobId: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { jobId } = request.params as { jobId: string };

      const [job] = await app.db
        .select()
        .from(processingJobs)
        .where(eq(processingJobs.id, jobId))
        .limit(1);

      if (!job) {
        return reply.code(404).send({ error: "NotFound", message: `No job with id "${jobId}"` });
      }

      return reply.send(job);
    }
  );
}
