// src/services/secrets/localFileSecretsProvider.ts
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ISecretsProvider } from "../../interfaces/index.js";

/**
 * Development secrets: the git-ignored `.secrets.local.json` in the working
 * directory, `{ "<logical name>": "<value>" }` (template:
 * `.secrets.local.example.json`). The only source in local mode — no
 * hard-coded fallbacks. Read once, at construction. Production uses
 * AzureKeyVaultSecretsProvider with the same logical names.
 */
export const LOCAL_SECRETS_FILE = ".secrets.local.json";

function readLocalSecrets(path: string): Record<string, string> {
  if (!existsSync(path)) {
    throw new Error(
      `${LOCAL_SECRETS_FILE} not found at ${path} — copy .secrets.local.example.json and fill it in`
    );
  }
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${LOCAL_SECRETS_FILE} must be a JSON object of name -> value`);
  }
  return Object.fromEntries(
    Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string" && e[1].trim() !== "")
  );
}

export class LocalFileSecretsProvider implements ISecretsProvider {
  private readonly secrets: Record<string, string>;

  constructor(localFile: string = resolve(process.cwd(), LOCAL_SECRETS_FILE)) {
    this.secrets = readLocalSecrets(localFile);
  }

  async getSecret(name: string): Promise<string> {
    const value = this.secrets[name];
    if (!value) {
      throw new Error(`Secret "${name}" is not set in ${LOCAL_SECRETS_FILE}`);
    }
    return value;
  }
}
