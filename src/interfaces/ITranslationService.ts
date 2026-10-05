export interface TranslateRequest {
  text: string;
  targetLanguage: string;
  /** Defaults to English. Set explicitly so DeepL never guesses from short segments. */
  sourceLanguage?: string;
  glossaryId?: string;
  context?: string;
}

export interface TranslateResult {
  translatedText: string;
}

/** Several texts in one call, sharing language, glossary and context. Results keep input order. */
export interface TranslateManyRequest extends Omit<TranslateRequest, "text"> {
  texts: string[];
}

export interface TranslateManyResult {
  translatedTexts: string[];
}

export interface ITranslationService {
  translate(request: TranslateRequest): Promise<TranslateResult>;
  translateMany(request: TranslateManyRequest): Promise<TranslateManyResult>;
}
