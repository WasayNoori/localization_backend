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

export class DummySecretsProvider implements ISecretsProvider {
  async getSecret(name: string): Promise<string> {
    const value = DUMMY_SECRETS[name];
    if (!value) {
      throw new Error(`No dummy secret configured for "${name}"`);
    }
    return value;
  }
}
