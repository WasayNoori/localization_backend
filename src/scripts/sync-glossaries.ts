// src/scripts/sync-glossaries.ts
//
// Copies DeepL glossary ids from Azure Key Vault into the glossaries table,
// which stays the runtime source (getGlossaryId). Run after creating or
// replacing a glossary in DeepL and updating its vault secret:
//
//   npm run glossaries:sync              # write changes
//   npm run glossaries:sync -- --dry-run # show what would change
//
// Glossary ids are always read from Key Vault (KEY_VAULT_URL, names mapped in
// config/key-vault-names.ts). The database connection comes from the
// configured SECRETS_PROVIDER, so this also works locally with the dummy
// provider. Glossary ids aren't secrets, so they are printed.
//
// A small composition root of its own, like a .NET console app's Program.cs.

import { env } from "../config/env.js";
import { KEY_VAULT_GLOSSARY_LANGUAGES, KEY_VAULT_SECRET_NAMES, glossarySecretName } from "../config/key-vault-names.js";
import { createDbClient } from "../db/client.js";
import { buildSecretsProvider } from "../plugins/container.js";
import { AzureKeyVaultSecretsProvider } from "../services/secrets/azureKeyVaultSecretsProvider.js";
import { findGlossary, upsertGlossary } from "../services/glossaries/upsertGlossary.js";

async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run");
  if (!env.KEY_VAULT_URL) {
    console.error("KEY_VAULT_URL is required (glossary ids are read from Key Vault).");
    return 1;
  }

  const vault = new AzureKeyVaultSecretsProvider(env.KEY_VAULT_URL, KEY_VAULT_SECRET_NAMES);
  const db = createDbClient(await buildSecretsProvider().getSecret("database-url"));

  let failed = 0;
  for (const language of KEY_VAULT_GLOSSARY_LANGUAGES) {
    let vaultId: string;
    try {
      vaultId = (await vault.getSecret(glossarySecretName(language))).trim();
    } catch (err) {
      failed++;
      console.error(`${language}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const current = await findGlossary(db, language);
    if (current?.deeplGlossaryId === vaultId) {
      console.log(`${language}: unchanged (${vaultId})`);
      continue;
    }
    const change = current ? `${current.deeplGlossaryId} -> ${vaultId}` : `set ${vaultId}`;
    if (!dryRun) {
      await upsertGlossary(db, language, vaultId);
    }
    console.log(`${language}: ${dryRun ? "would " : ""}${change}`);
  }

  if (dryRun) console.log("Dry run: nothing written.");
  return failed ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
