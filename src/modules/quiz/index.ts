// src/modules/quiz/index.ts
// Quiz translation module — interim, fully detachable (see README.md).
// The app plugs it in with one line in app.ts: `await app.register(quizModule)`.
// It wires its own pieces here (not in plugins/container.ts) from services the
// app already exposes, and stores nothing of its own in the database.
import type { FastifyInstance } from "fastify";
import { BoxQuizWorkbookStore } from "./BoxQuizWorkbookStore.js";
import { DbQuizCourseContext } from "./DbQuizCourseContext.js";
import { MondayQuizSource } from "./MondayQuizSource.js";
import { quizRoutes } from "./quiz.route.js";
import type { QuizJobDeps } from "./quizTranslationJob.js";

export async function quizModule(app: FastifyInstance): Promise<void> {
  const deps: QuizJobDeps = {
    db: app.db,
    translationService: app.translationService,
    translationReviewer: app.translationReviewer,
    courseContext: new DbQuizCourseContext(app.db),
    source: new MondayQuizSource(app.secretsProvider),
    output: new BoxQuizWorkbookStore(app.fileStorageService),
  };
  await app.register(quizRoutes(deps));
}
