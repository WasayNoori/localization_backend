// src/services/translation/lengthCheck.ts
// DeepL occasionally drops part of a text — whole sentences, or everything but
// one glossary term (docs/decisions.md, "Length check"). The languages we
// translate into all run longer than English, so a translation much shorter
// than its English is almost certainly truncated.

/** Minimum translated/English length per target language. Languages not listed aren't checked (e.g. CJK runs shorter). */
const MIN_RATIO: Readonly<Record<string, number>> = { fr: 0.75, es: 0.75, it: 0.75, de: 0.75, pt: 0.75 };

/** Short English (names, single words) varies too much to judge. */
// Shorter English is skipped: with one sentence per segment, a concise but correct translation
// of a short line (e.g. 36 for 49 characters) often falls under the ratio.
const MIN_SOURCE_CHARS = 60;

/** A one-line reason when the translation looks truncated, else null. */
export function lengthWarning(source: string, translation: string, language: string): string | null {
  const minRatio = MIN_RATIO[language];
  if (!minRatio || source.length < MIN_SOURCE_CHARS) return null;
  if (translation.length >= source.length * minRatio) return null;
  return `Translation looks truncated: ${translation.length} characters for ${source.length} of English (expected at least ${Math.ceil(source.length * minRatio)})`;
}
