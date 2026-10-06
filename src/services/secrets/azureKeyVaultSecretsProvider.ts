import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
import type { ISecretsProvider } from "../../interfaces/index.js";

export class AzureKeyVaultSecretsProvider implements ISecretsProvider {
  private readonly client: SecretClient;

  /**
   * @param vaultNames logical name → Key Vault secret name (config/key-vault-names.ts).
   *   Logical names without an entry are looked up as-is.
   */
  constructor(
    vaultUrl: string,
    private readonly vaultNames: Readonly<Record<string, string>> = {}
  ) {
    this.client = new SecretClient(vaultUrl, new DefaultAzureCredential());
  }

  async getSecret(name: string): Promise<string> {
    const vaultName = this.vaultNames[name] ?? name;
    const label = vaultName === name ? `"${name}"` : `"${vaultName}" (for "${name}")`;
    const secret = await this.client.getSecret(vaultName).catch((err: unknown) => {
      throw new Error(`Key Vault secret ${label} could not be read: ${err instanceof Error ? err.message : String(err)}`);
    });
    if (!secret.value) {
      throw new Error(`Key Vault secret ${label} has no value`);
    }
    return secret.value;
  }
}
