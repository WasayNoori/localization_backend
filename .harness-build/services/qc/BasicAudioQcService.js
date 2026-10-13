// Floor-level check only: a synthesis call that returns no/near-empty audio
// is the one failure mode we can catch without decoding the file. Duration,
// silence, and other acoustic checks are separate, later work.
const MIN_AUDIO_BYTES = 1024;
export class BasicAudioQcService {
    async check(audio) {
        const issues = [];
        if (audio.byteLength === 0) {
            issues.push("Audio buffer is empty");
        }
        else if (audio.byteLength < MIN_AUDIO_BYTES) {
            issues.push(`Audio buffer is suspiciously small (${audio.byteLength} bytes)`);
        }
        return { passed: issues.length === 0, issues };
    }
}
//# sourceMappingURL=BasicAudioQcService.js.map