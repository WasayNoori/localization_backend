// src/plugins/secrets-provider.ts
// Picks the ISecretsProvider for SECRETS_PROVIDER. Its own module (not in
// container.ts) so CLI scripts in src/scripts can use it without loading
// every service SDK the server wires up.
import { env } from "../config/env.js";
import { KEY_VAULT_SECRET_NAMES } from "../config/key-vault-names.js";
import type { ISecretsProvider } from "../interfaces/index.js";
import { AzureKeyVaultSecretsProvider } from "../services/secrets/azureKeyVaultSecretsProvider.js";
import { CachingSecretsProvider } from "../services/secrets/cachingSecretsProvider.js";
import { DummySecretsProvider } from "../services/secrets/dummySecretsProvider.js";

export function buildSecretsProvider(): ISecretsProvider {
  if (env.SECRETS_PROVIDER === "azure-key-vault") {
    if (!env.KEY_VAULT_URL) {
      throw new Error("KEY_VAULT_URL is required when SECRETS_PROVIDER=azure-key-vault");
    }
    return new CachingSecretsProvider(new AzureKeyVaultSecretsProvider(env.KEY_VAULT_URL, KEY_VAULT_SECRET_NAMES));
  }
  return new CachingSecretsProvider(new DummySecretsProvider());
}
