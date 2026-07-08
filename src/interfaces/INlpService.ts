export interface INlpService {
  analyze(text: string): Promise<unknown>;
}
