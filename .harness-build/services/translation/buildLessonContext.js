// src/services/translation/buildLessonContext.ts
import { createHash } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { lessonSegments } from "../../db/schema.js";
// DeepL caps a whole request at 128 KiB. Keep the context well under that
// (UTF-8 accented text can be ~2 bytes/char) and fall back to a window of
// neighbouring segments for unusually long scripts.
const MAX_CONTEXT_CHARS = 50_000;
const WINDOW_RADIUS = 4;
/**
 * Builds DeepL context from a lesson's segments (ordered by sequence_index):
 * the whole English script, so terminology and tone stay consistent across
 * segments while each translation still maps 1:1 to its segment.
 * Pure — no DB or network.
 */
export function buildLessonContext(segments) {
    const full = segments.map((s) => s.text).join("\n");
    if (full.length <= MAX_CONTEXT_CHARS) {
        const fullContext = { text: full, descriptor: `lesson-script sha256:${shortHash(full)}` };
        return { forIndex: () => fullContext };
    }
    return {
        forIndex(segmentIndex) {
            const start = Math.max(0, segmentIndex - WINDOW_RADIUS);
            const end = Math.min(segments.length, segmentIndex + WINDOW_RADIUS + 1);
            const text = segments.slice(start, end).map((s) => s.text).join("\n");
            return { text, descriptor: `segments ${start + 1}-${end} sha256:${shortHash(text)}` };
        },
    };
}
/** Loads a lesson's segments and builds its context — for callers that only hold one segment. */
export async function loadLessonContext(db, lessonId) {
    const segments = await db
        .select()
        .from(lessonSegments)
        .where(eq(lessonSegments.lessonId, lessonId))
        .orderBy(asc(lessonSegments.sequenceIndex));
    return { segments, context: buildLessonContext(segments) };
}
function shortHash(text) {
    return createHash("sha256").update(text).digest("hex").slice(0, 12);
}
//# sourceMappingURL=buildLessonContext.js.map