export interface IAudioQcService {
  check(audio: Buffer): Promise<{ passed: boolean; issues: string[] }>;
}
