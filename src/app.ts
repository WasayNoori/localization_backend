import Fastify, { type FastifyInstance } from "fastify";
import { container } from "./plugins/container.js";
import { auth } from "./plugins/auth.js";
import { swaggerDocs } from "./plugins/swagger.js";
import { routes } from "./routes/index.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(container);
  await app.register(swaggerDocs);
  await app.register(auth);
  await app.register(routes);

  return app;
}
