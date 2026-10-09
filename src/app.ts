import Fastify, { type FastifyInstance } from "fastify";
import { container } from "./plugins/container.js";
import { auth } from "./plugins/auth.js";
import { swaggerDocs } from "./plugins/swagger.js";
import { routes } from "./routes/index.js";
import { quizModule } from "./modules/quiz/index.js";
import { mondayOutlineModule } from "./modules/monday-outline/index.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(container);
  await app.register(swaggerDocs);
  await app.register(auth);
  await app.register(routes);
  // Detachable module: remove this line and src/modules/quiz to take quiz translation out.
  await app.register(quizModule);
  // Detachable module: remove this line and src/modules/monday-outline to take it out.
  await app.register(mondayOutlineModule);

  return app;
}
