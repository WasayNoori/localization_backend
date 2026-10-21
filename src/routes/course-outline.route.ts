// src/routes/course-outline.route.ts
// The console builds the outline workbook; this stores it in Box.
import type { FastifyInstance } from "fastify";
import { CourseOutlineError, saveCourseOutline } from "../services/output/saveCourseOutline.js";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export async function courseOutlineRoute(app: FastifyInstance) {
  // Raw file bodies — scoped to this plugin (Fastify encapsulation), so other routes stay JSON-only.
  app.addContentTypeParser([XLSX, "application/octet-stream"], { parseAs: "buffer", bodyLimit: 20 * 1024 * 1024 }, (_req, body, done) =>
    done(null, body)
  );

  app.put(
    "/courses/:courseId/outputs/outline/:language",
    {
      schema: {
        description:
          "Saves the course outline workbook (the console's Excel export; the raw .xlsx as the body, " +
          `Content-Type ${XLSX}) into the course's Box folder as <LANG>/<courseId> Outline <LANG>.xlsx. ` +
          "An existing file of that name gets a new version (same file id, history kept). Returns " +
          "{ fileId, path, unchanged }. 400 no Box folder / not an .xlsx, 404 unknown course.",
        tags: ["courses"],
        security: [{ apiKey: [] }],
        params: {
          type: "object",
          required: ["courseId", "language"],
          properties: { courseId: { type: "string" }, language: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      const { courseId, language } = request.params as { courseId: string; language: string };
      if (!Buffer.isBuffer(request.body)) {
        return reply.code(400).send({ error: "BadRequest", message: `Send the .xlsx as the body with Content-Type ${XLSX}` });
      }
      try {
        return reply.send(
          await saveCourseOutline({ db: app.db, fileStorageService: app.fileStorageService }, courseId, language.toLowerCase(), request.body)
        );
      } catch (err) {
        if (err instanceof CourseOutlineError) {
          return reply.code(err.statusCode).send({ error: err.statusCode === 404 ? "NotFound" : "BadRequest", message: err.message });
        }
        throw err;
      }
    }
  );
}
