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

export interface ITranslationService {
  translate(request: TranslateRequest): Promise<TranslateResult>;
}
