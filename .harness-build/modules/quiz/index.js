import { BoxQuizWorkbookStore } from "./BoxQuizWorkbookStore.js";
import { DbQuizCourseContext } from "./DbQuizCourseContext.js";
import { MondayQuizSource } from "./MondayQuizSource.js";
import { quizRoutes } from "./quiz.route.js";
export async function quizModule(app) {
    const deps = {
        db: app.db,
        translationService: app.translationService,
        translationReviewer: app.translationReviewer,
        courseContext: new DbQuizCourseContext(app.db),
        source: new MondayQuizSource(app.mondayBoardReader),
        output: new BoxQuizWorkbookStore(app.fileStorageService),
    };
    await app.register(quizRoutes(deps));
}
//# sourceMappingURL=index.js.map