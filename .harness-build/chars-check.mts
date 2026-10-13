import { createDbClient } from "../src/db/client.ts";
import { getCourseCharacterCounts } from "../src/services/catalog/getCourseCharacterCounts.ts";
import { buildSecretsProvider } from "./scripts/vm-secrets.js";
const db = createDbClient(await buildSecretsProvider().getSecret("database-url"));
for (const id of ["25SWSimPro", "25PDMPro"]) {
  const c = await getCourseCharacterCounts(db, id, ["en", "fr", "es", "it", "de"]);
  console.log(id, JSON.stringify(c.english));
  for (const l of c.languages) console.log(" ", l.language, JSON.stringify(l.translation), JSON.stringify(l.audio), l.expansionRatio);
}
process.exit(0);
