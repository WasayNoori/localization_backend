export class VoiceNotConfiguredError extends Error {
    language;
    constructor(language) {
        super(`No voice configured for "${language}" — set it in Settings (PUT /languages/${language}/voice-settings)`);
        this.language = language;
    }
}
//# sourceMappingURL=IvoiceSettingsProvider.js.map