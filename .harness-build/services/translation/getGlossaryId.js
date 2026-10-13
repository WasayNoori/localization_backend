// src/services/translation/getGlossaryId.ts
import { eq } from "drizzle-orm";
import { glossaries } from "../../db/schema.js";
/**
 * Looks up the DeepL glossary id configured for one target language, if
 * any. Shared by translateAndStoreSegment (generate-stage) and the
 * standalone /translate endpoint so neither hardcodes/duplicates the
 * glossaries lookup.
 */
export async function getGlossaryId(db, targetLanguage) {
    const [glossary] = await db
        .select()
        .from(glossaries)
        .where(eq(glossaries.targetLanguage, targetLanguage))
        .limit(1);
    return glossary?.deeplGlossaryId;
}
//# sourceMappingURL=getGlossaryId.js.map