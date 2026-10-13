import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";
export function createDbClient(connectionString) {
    const client = postgres(connectionString);
    return drizzle(client, { schema });
}
//# sourceMappingURL=client.js.map