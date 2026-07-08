import type { ISecretsProvider } from "../../interfaces/index.js";

const DUMMY_SECRETS: Record<string, string> = {
  API_KEY: "dev-dummy-key",
  DATABASE_URL: "postgres://user:password@localhost:5432/localization_dev",
  ELEVENLABS_API_KEY: "sk_01bf91ad29149af7f354180fa0ece7ab08d62bbac59c068c"
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
