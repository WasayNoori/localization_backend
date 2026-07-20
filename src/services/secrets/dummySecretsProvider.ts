import type { ISecretsProvider } from "../../interfaces/index.js";

const DUMMY_SECRETS: Record<string, string> = {
  "api-key": "dev-dummy-key",
  "database-url": "postgres://user:password@localhost:5432/localization_dev",
  "elevenlabs-api-key": "sk_01bf91ad29149af7f354180fa0ece7ab08d62bbac59c068c",
  "deepl-api-key": "dev-dummy-deepl-key",
  "box-client-id": "dev-dummy-box-client-id",
  "box-client-secret": "dev-dummy-box-client-secret",
  "box-enterprise-id": "dev-dummy-box-enterprise-id"
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
