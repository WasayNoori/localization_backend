import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
import type { ISecretsProvider } from "../../interfaces/index.js";

export class AzureKeyVaultSecretsProvider implements ISecretsProvider {
  private readonly client: SecretClient;

  constructor(vaultUrl: string) {
    this.client = new SecretClient(vaultUrl, new DefaultAzureCredential());
  }

  async getSecret(name: string): Promise<string> {
    const secret = await this.client.getSecret(name);
    if (!secret.value) {
      throw new Error(`Secret "${name}" has no value in Key Vault`);
    }
    return secret.value;
  }
}
