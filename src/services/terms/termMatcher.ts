// src/services/terms/termMatcher.ts
// Finds ambiguous terms in English text: case-insensitive, whole words, with
// plural forms (Tab/Tabs, Assembly/Assemblies). Multi-word terms allow any
// whitespace between words.

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function termPattern(term: string): RegExp {
  const words = term.trim().split(/\s+/).map(escape);
  const last = words.pop()!;
  // Assembly → Assembly|Assemblies; otherwise optional s/es.
  const lastForms = /y$/i.test(last) && last.length > 2 ? `(?:${last}|${last.slice(0, -1)}ies)` : `${last}(?:e?s)?`;
  const body = [...words, lastForms].join("\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "iu");
}

export interface MatchableTerm {
  id: string;
  term: string;
}

/** Ids of the terms that appear in the text. */
export function findTerms<T extends MatchableTerm>(text: string, terms: T[]): T[] {
  return terms.filter((t) => termPattern(t.term).test(text));
}
