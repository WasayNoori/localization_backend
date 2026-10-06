// src/interfaces/ITranslationReviewer.ts

/** One translated piece of course scaffolding to sanity-check. */
export interface ReviewItem {
  /** Caller's id for matching verdicts back (e.g. "section:<uuid>"). */
  key: string;
  kind: "course" | "section" | "lessonName" | "lessonDescription";
  source: string;
  translation: string;
}

export interface ReviewRequest {
  /** Target language code, e.g. "fr". Source is always English. */
  targetLanguage: string;
  /** English course outline (course, section and lesson titles) for context. */
  context: string;
  items: ReviewItem[];
}

export interface ReviewVerdict {
  key: string;
  /** True only when the translation is clearly wrong — never for style or preference. */
  flagged: boolean;
  /** One sentence, only when flagged. */
  reason: string | null;
}

/**
 * Second opinion on machine translations. Biased toward the translation:
 * flags clearly wrong items only and never proposes alternatives — DeepL's
 * text is always what's stored.
 */
export interface ITranslationReviewer {
  review(request: ReviewRequest): Promise<ReviewVerdict[]>;
}
