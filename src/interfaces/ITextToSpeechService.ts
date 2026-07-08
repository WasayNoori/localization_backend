export interface ITextToSpeechService {
  synthesize(text: string, voice: string): Promise<Buffer>;
}
