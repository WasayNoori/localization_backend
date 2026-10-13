import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
export class AzureKeyVaultSecretsProvider {
    vaultNames;
    client;
    /**
     * @param vaultNames logical name → Key Vault secret name (config/key-vault-names.ts).
     *   Logical names without an entry are looked up as-is.
     */
    constructor(vaultUrl, vaultNames = {}) {
        this.vaultNames = vaultNames;
        this.client = new SecretClient(vaultUrl, new DefaultAzureCredential());
    }
    async getSecret(name) {
        const vaultName = this.vaultNames[name] ?? name;
        const label = vaultName === name ? `"${name}"` : `"${vaultName}" (for "${name}")`;
        const secret = await this.client.getSecret(vaultName).catch((err) => {
            throw new Error(`Key Vault secret ${label} could not be read: ${err instanceof Error ? err.message : String(err)}`);
        });
        if (!secret.value) {
            throw new Error(`Key Vault secret ${label} has no value`);
        }
        return secret.value;
    }
}
//# sourceMappingURL=azureKeyVaultSecretsProvider.js.map