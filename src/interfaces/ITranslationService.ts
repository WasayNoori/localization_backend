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

/** A glossary as the translation provider reports it. Languages are lowercase codes. */
export interface GlossaryInfo {
  id: string;
  name: string;
  sourceLanguage: string;
  targetLanguage: string;
  entryCount: number;
  createdAt: Date;
  /** False while the provider is still building it — not usable yet. */
  ready: boolean;
}

export interface ITranslationService {
  translate(request: TranslateRequest): Promise<TranslateResult>;
  translateMany(request: TranslateManyRequest): Promise<TranslateManyResult>;
  /** Every glossary on the account. */
  listGlossaries(): Promise<GlossaryInfo[]>;
}
