// src/scripts/sync-glossaries.ts
//
// Points the glossaries table at the account's current DeepL glossaries
// (newest ready English→X glossary per language). Run after uploading a
// glossary — DeepL can't update one in place, so every upload is a new id:
//
//   npm run glossaries:sync              # write changes
//   npm run glossaries:sync -- --dry-run # show what would change
//
// Same as POST /glossaries/sync. Uses the configured SECRETS_PROVIDER for
// the DeepL key and database. A small composition root of its own, like a
// .NET console app's Program.cs.

import { createDbClient } from "../db/client.js";
import { buildSecretsProvider } from "../plugins/secrets-provider.js";
import { DeepLTranslationService } from "../services/translation/DeepLTranslationService.js";
import { syncGlossariesFromProvider } from "../services/glossaries/syncGlossariesFromProvider.js";

async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run");
  const secrets = buildSecretsProvider();
  const db = createDbClient(await secrets.getSecret("database-url"));
  const r = await syncGlossariesFromProvider({ db, translationService: new DeepLTranslationService(secrets) }, { dryRun });

  for (const c of r.changed) {
    console.log(`${c.language}: ${dryRun ? "would " : ""}${c.from ? `${c.from} -> ` : "set "}${c.to}  (${c.name}, ${c.entryCount} entries)`);
  }
  for (const u of r.unchanged) console.log(`${u.language}: unchanged (${u.name})`);
  for (const i of r.ignored) console.log(`${i.language}: ignoring older glossary ${i.id} (${i.name}) — consider deleting it in DeepL`);
  for (const n of r.notInProvider) console.log(`${n.language}: WARNING no glossary in DeepL; table still points at ${n.id}`);
  if (dryRun) console.log("Dry run: nothing written.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
