export interface NlpSegmentResult {
  sentences: string[];
  originalLength: number;
  grammarCorrected: boolean;
}

export interface INlpService {
  segment(text: string, correctGrammar?: boolean): Promise<NlpSegmentResult>;
}
