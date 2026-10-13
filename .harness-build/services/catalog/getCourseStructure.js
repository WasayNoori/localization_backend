// src/services/catalog/getCourseStructure.ts
import { asc, eq, inArray } from "drizzle-orm";
import { courses, courseSections, courseLessons, courseTranslations, lessons, lessonTranslations, sectionTranslations, } from "../../db/schema.js";
import { courseTitlesStale, lessonTitlesStale } from "../translation/translateScaffolding.js";
import { getLocalizationCoverage, sumCoverage } from "./getLocalizationCoverage.js";
export const reviewOf = (r) => ({
    status: r.reviewStatus === "ok" || r.reviewStatus === "flagged" ? r.reviewStatus : null,
    note: r.reviewNote,
    edited: r.editedAt !== null,
});
/** Read-only: course → ordered sections → ordered lessons, with parse state. Null if the course doesn't exist. */
export async function getCourseStructure(db, courseId) {
    const [course] = await db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
    if (!course)
        return null;
    const sectionRows = await db
        .select()
        .from(courseSections)
        .where(eq(courseSections.courseId, courseId))
        .orderBy(asc(courseSections.sectionIndex));
    const memberRows = await db
        .select({
        sectionId: courseLessons.sectionId,
        position: courseLessons.position,
        lesson: lessons,
    })
        .from(courseLessons)
        .innerJoin(lessons, eq(courseLessons.lessonId, lessons.id))
        .where(eq(courseLessons.courseId, courseId))
        .orderBy(asc(courseLessons.position), asc(lessons.id));
    const lessonIds = memberRows.map((m) => m.lesson.id);
    const coverage = await getLocalizationCoverage(db, lessonIds);
    const sectionIds = sectionRows.map((s) => s.id);
    const [courseTr, sectionTr, lessonTr] = await Promise.all([
        db.select().from(courseTranslations).where(eq(courseTranslations.courseId, courseId)),
        sectionIds.length
            ? db.select().from(sectionTranslations).where(inArray(sectionTranslations.sectionId, sectionIds))
            : Promise.resolve([]),
        lessonIds.length
            ? db.select().from(lessonTranslations).where(inArray(lessonTranslations.lessonId, lessonIds))
            : Promise.resolve([]),
    ]);
    const byLanguage = (a, b) => a.targetLanguage.localeCompare(b.targetLanguage);
    const toLesson = (m) => {
        const l = m.lesson;
        return {
            id: l.id,
            lessonName: l.lessonName,
            description: l.description,
            position: m.position,
            hasScript: l.scriptText !== null,
            boxFileId: l.boxFileId,
            parsedAt: l.parsedAt,
            segmentCount: coverage.get(l.id).segmentCount,
            parseStale: !!(l.parsedAt && l.scriptUpdatedAt && l.scriptUpdatedAt > l.parsedAt),
            localization: coverage.get(l.id).languages,
            tags: l.tags,
            translations: lessonTr
                .filter((t) => t.lessonId === l.id)
                .sort(byLanguage)
                .map((t) => ({
                language: t.targetLanguage,
                lessonName: t.lessonName,
                description: t.description,
                stale: lessonTitlesStale(t, l),
                review: reviewOf(t),
            })),
        };
    };
    const totals = sumCoverage(lessonIds.map((id) => coverage.get(id)));
    return {
        id: course.id,
        courseName: course.courseName,
        description: course.description,
        status: course.status,
        boxFolderId: course.boxFolderId,
        mondayBoardId: course.mondayBoardId,
        updatedAt: course.updatedAt,
        segmentCount: totals.segmentCount,
        coverage: totals.languages,
        translations: courseTr
            .sort(byLanguage)
            .map((t) => ({
            language: t.targetLanguage,
            courseName: t.courseName,
            description: t.description,
            stale: courseTitlesStale(t, course),
            review: reviewOf(t),
        })),
        sections: sectionRows.map((s) => ({
            id: s.id,
            sectionIndex: s.sectionIndex,
            title: s.title,
            translations: sectionTr
                .filter((t) => t.sectionId === s.id)
                .sort(byLanguage)
                .map((t) => ({ language: t.targetLanguage, title: t.title, stale: t.sourceTitle !== s.title, review: reviewOf(t) })),
            lessons: memberRows.filter((m) => m.sectionId === s.id).map(toLesson),
        })),
        unsectionedLessons: memberRows.filter((m) => m.sectionId === null).map(toLesson),
    };
}
//# sourceMappingURL=getCourseStructure.js.map