import { buildApp } from "./app.js";
import { env } from "./config/env.js";

const app = await buildApp();

app.listen({ port: env.PORT, host: env.HOST }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
