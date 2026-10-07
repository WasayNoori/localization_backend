import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),
  SECRETS_PROVIDER: z.enum(["dummy", "azure-key-vault"]).default("dummy"),
  KEY_VAULT_URL: z.string().optional(),
  SPACY_SERVICE_URL: z.string(),
  // Default Box folder for generated audio until the Box structure is
  // decided (docs/decisions.md). Not a secret — a folder id.
  BOX_AUDIO_FOLDER_ID: z.string().optional(),
  // Claude model for the scaffolding translation sanity check. Not a secret;
  // the API key comes from ISecretsProvider ("anthropic-api-key").
  ANTHROPIC_REVIEW_MODEL: z.string().default("claude-sonnet-5-5"),
  // Root folder for lesson outputs (Segments.txt, later audio) until Box is
  // decided, e.g. C:\Translations. Not a secret. Unset = output endpoints 400.
  LOCAL_OUTPUT_ROOT: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export const env: Env = envSchema.parse(process.env);