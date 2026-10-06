// src/services/glossaries/upsertGlossary.ts
import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { glossaries } from "../../db/schema.js";

export type GlossaryRow = typeof glossaries.$inferSelect;

/** Current glossary row for one language, or undefined. */
export async function findGlossary(db: Database, targetLanguage: string): Promise<GlossaryRow | undefined> {
  const [row] = await db.select().from(glossaries).where(eq(glossaries.targetLanguage, targetLanguage)).limit(1);
  return row;
}

/**
 * Sets the DeepL glossary id for one target language (one row per language).
 * Shared by PUT /languages/:targetLanguage/glossary and `npm run glossaries:sync`.
 */
export async function upsertGlossary(db: Database, targetLanguage: string, deeplGlossaryId: string): Promise<GlossaryRow> {
  const [saved] = await db
    .insert(glossaries)
    .values({ targetLanguage, deeplGlossaryId })
    .onConflictDoUpdate({
      target: glossaries.targetLanguage,
      set: { deeplGlossaryId, updatedAt: new Date() },
    })
    .returning();
  return saved;
}
