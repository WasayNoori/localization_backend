// src/config/key-vault-names.ts
//
// The code asks ISecretsProvider for logical names ("deepl-api-key"); the
// Key Vault ("AIFastAPI") is shared with other apps and uses its own names.
// This is the one place that maps between them. Names not listed here are
// looked up in the vault as-is. Key Vault names are case-insensitive.
// DummySecretsProvider ignores this map and uses the logical names.

export const KEY_VAULT_SECRET_NAMES: Readonly<Record<string, string>> = {
  "deepl-api-key": "SP-DEEPL-API-KEY",
  "anthropic-api-key": "Claude-API-Key",
  "elevenlabs-api-key": "ElevenLabsAPIKey",
  // DeepL glossary ids — read only by `npm run glossaries:sync`, which copies
  // them into the glossaries table (the runtime source; see decisions.md).
  "deepl-glossary-es": "DeeplGlossary-Spanish",
  "deepl-glossary-fr": "DeeplGlossary-French",
  "deepl-glossary-it": "DeeplGlossary-Italian",
};

/** Target languages whose glossary id lives in the vault as `deepl-glossary-<lang>`. */
export const KEY_VAULT_GLOSSARY_LANGUAGES = ["es", "fr", "it"] as const;

export const glossarySecretName = (targetLanguage: string) => `deepl-glossary-${targetLanguage}`;
