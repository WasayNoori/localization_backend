import { glossaries } from "../../db/schema.js";
import { upsertGlossary } from "./upsertGlossary.js";
/**
 * Points the glossaries table at the account's current DeepL glossaries:
 * for each target language, the newest ready English→X glossary. DeepL can't
 * replace a glossary's entries in place, so updating one means delete +
 * re-create = a new id; run this after every glossary upload. Never deletes
 * table rows.
 */
export async function syncGlossariesFromProvider(deps, options = {}) {
    const dryRun = !!options.dryRun;
    const available = (await deps.translationService.listGlossaries()).filter((g) => g.sourceLanguage === "en" && g.ready);
    const current = await deps.db.select().from(glossaries);
    const byLanguage = new Map();
    for (const g of available)
        byLanguage.set(g.targetLanguage, [...(byLanguage.get(g.targetLanguage) ?? []), g]);
    const result = { dryRun, changed: [], unchanged: [], ignored: [], notInProvider: [] };
    for (const [language, list] of [...byLanguage].sort(([a], [b]) => a.localeCompare(b))) {
        const [newest, ...older] = [...list].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        result.ignored.push(...older.map((g) => ({ language, id: g.id, name: g.name, createdAt: g.createdAt })));
        const row = current.find((r) => r.targetLanguage === language);
        if (row?.deeplGlossaryId === newest.id) {
            result.unchanged.push({ language, id: newest.id, name: newest.name });
            continue;
        }
        if (!dryRun)
            await upsertGlossary(deps.db, language, newest.id);
        result.changed.push({ language, from: row?.deeplGlossaryId ?? null, to: newest.id, name: newest.name, entryCount: newest.entryCount });
    }
    result.notInProvider = current
        .filter((r) => !byLanguage.has(r.targetLanguage))
        .map((r) => ({ language: r.targetLanguage, id: r.deeplGlossaryId }));
    return result;
}
//# sourceMappingURL=syncGlossariesFromProvider.js.map