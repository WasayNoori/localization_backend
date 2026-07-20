import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),
  SECRETS_PROVIDER: z.enum(["dummy", "azure-key-vault"]).default("dummy"),
  KEY_VAULT_URL: z.string().optional(),
  SPACY_SERVICE_URL: z.string(),
});

export type Env = z.infer<typeof envSchema>;

export const env: Env = envSchema.parse(process.env);