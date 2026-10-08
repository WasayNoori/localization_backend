// src/routes/jobs.route.ts
import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { processingJobs } from "../db/schema.js";

export async function jobsRoute(app: FastifyInstance) {
  app.get(
    "/courses/:courseId/jobs",
    {
      schema: {
        description:
          "The course's most recent processing jobs (newest first, up to 20) — translation ('translate') and " +
          "audio ('generate') per language — so a page can show and resume polling jobs that are still running.",
        security: [{ apiKey: [] }],
        params: { type: "object", required: ["courseId"], properties: { courseId: { type: "string" } } },
      },
    },
    async (request) => {
      const { courseId } = request.params as { courseId: string };
      return app.db
        .select()
        .from(processingJobs)
        .where(and(eq(processingJobs.scope, "course"), eq(processingJobs.targetId, courseId)))
        .orderBy(desc(processingJobs.createdAt))
        .limit(20);
    }
  );

  app.get(
    "/jobs/:jobId",
    {
      schema: {
        description:
          "Poll a course-level processing job. Returns the processing_jobs row as-is: status " +
          "('pending' | 'running' | 'completed' | 'failed'), progress ({ total, succeeded, failed, skipped, " +
          "stats?, error? }), " +
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
