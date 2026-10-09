// src/modules/monday-outline/mondayOutline.route.ts
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { courses } from "../../db/schema.js";
import { MondayApiError } from "../../interfaces/IMondayBoardReader.js";
import { CourseImportValidationError, importCourseStructure } from "../../services/catalog/importCourseStructure.js";
import { MondayOutlineError, readMondayOutline } from "./readMondayOutline.js";

export async function mondayOutlineRoutes(app: FastifyInstance) {
  app.post(
    "/courses/:courseId/import/monday",
    {
      schema: {
        description:
          "Monday outline module — imports the course's sections and lessons from its Monday board: groups " +
          "\"Section N - Title\" become sections, their items lessons (item name = lesson id; Lesson Name, Lesson " +
          "Description, Lesson Level Tags). Lesson ids: an existing lesson matching ignoring case keeps its id; " +
          "otherwise a course-id prefix gets the course id's casing; otherwise kept as is (reported). Then the " +
          "same import as POST /courses/import — `?dryRun=true` previews. Returns the import result plus `monday` " +
          "(what was read, id changes, skipped groups/items). Course name/description/status unchanged. " +
          "400 no Monday board / board unreadable / invalid structure, 404 unknown course.",
        tags: ["monday-outline"],
        security: [{ apiKey: [] }],
        params: { type: "object", required: ["courseId"], properties: { courseId: { type: "string" } } },
        querystring: { type: "object", properties: { dryRun: { type: "boolean" } } },
      },
    },
    async (request, reply) => {
      const { courseId } = request.params as { courseId: string };
      const { dryRun } = request.query as { dryRun?: boolean };
      const [course] = await app.db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
      if (!course) return reply.code(404).send({ error: "NotFound", message: `No course with id "${courseId}"` });
      try {
        const { input, report } = await readMondayOutline({ db: app.db, monday: app.mondayBoardReader }, course);
        if (!input.sections.length) {
          return reply.code(400).send({ error: "BadRequest", message: `No "Section N - Title" groups on Monday board ${report.board}` });
        }
        const result = await importCourseStructure(app.db, input, { dryRun });
        return reply.send({ ...result, monday: report });
      } catch (err) {
        if (err instanceof MondayOutlineError || err instanceof MondayApiError || err instanceof CourseImportValidationError) {
          return reply.code(400).send({ error: "BadRequest", message: err.message });
        }
        throw err;
      }
    }
  );
}
