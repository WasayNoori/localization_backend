import type { FastifyInstance } from "fastify";
import { healthRoute } from "./health.route.js";
import { ttsRoute } from "./tts.route.js";
import { translationRoute } from "./translation.route.js";

export async function routes(app: FastifyInstance) {
  await app.register(healthRoute);
  await app.register(ttsRoute);
  await app.register(translationRoute);
}
