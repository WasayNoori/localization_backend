export interface TranslateRequest {
  text: string;
  targetLanguage: string;
  glossaryId?: string;
  context?: string;
}

export interface TranslateResult {
  translatedText: string;
}

export interface ITranslationService {
  translate(request: TranslateRequest): Promise<TranslateResult>;
}
