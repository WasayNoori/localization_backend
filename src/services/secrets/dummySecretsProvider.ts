import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ISecretsProvider } from "../../interfaces/index.js";

const DUMMY_SECRETS: Record<string, string> = {
  "api-key": "dev-dummy-key",
  "database-url":
    "postgresql://sppostgresadmin:~profess0r@sppostgresserver.postgres.database.azure.com:5432/LocalizationDB?sslmode=require",
  "elevenlabs-api-key": "sk_01bf91ad29149af7f354180fa0ece7ab08d62bbac59c068c",
  "deepl-api-key": "77221d45-2b78-4bc4-8cbe-0b27088999c5",
  // Box Developer Token (~1hr expiry, from the Box dev console) — used
  // directly by BoxDeveloperTokenAuth for local testing. box-client-id/
  // -secret/-enterprise-id (BoxCcgAuth) aren't wired up/used right now;
  // revisit before deploying somewhere that needs long-lived Box auth.
  "box-dev-token": "jh7rtIfcP8ng6kHctHXEp2m53eRQsrzQ"
};

/**
 * Optional, git-ignored `.secrets.local.json` in the working directory:
 * `{ "anthropic-api-key": "..." }`, keyed by logical name (same names as
 * above). Its values win over DUMMY_SECRETS, so real keys can live outside
 * source control. Read once, at construction.
 */
export const LOCAL_SECRETS_FILE = ".secrets.local.json";

function readLocalSecrets(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${LOCAL_SECRETS_FILE} must be a JSON object of name -> value`);
  }
  return Object.fromEntries(
    Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string" && e[1].trim() !== "")
  );
}

export class DummySecretsProvider implements ISecretsProvider {
  private readonly secrets: Record<string, string>;

  constructor(localFile: string = resolve(process.cwd(), LOCAL_SECRETS_FILE)) {
    this.secrets = { ...DUMMY_SECRETS, ...readLocalSecrets(localFile) };
  }

  async getSecret(name: string): Promise<string> {
    const value = this.secrets[name];
    if (!value) {
      throw new Error(`No dummy secret configured for "${name}" (add it to ${LOCAL_SECRETS_FILE})`);
    }
    return value;
  }
}
