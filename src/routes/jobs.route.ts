// src/routes/jobs.route.ts
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { processingJobs } from "../db/schema.js";

export async function jobsRoute(app: FastifyInstance) {
  app.get(
    "/jobs/:jobId",
    {
      schema: {
        description:
          "Poll a course-level processing job. Returns the processing_jobs row as-is: status " +
          "('pending' | 'running' | 'completed' | 'failed'), progress ({ succeeded, failed, total }), " +
          "timestamps. This IS the polling endpoint for the 202 job IDs returned by course-level " +
          "parse/generate endpoints.",
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
