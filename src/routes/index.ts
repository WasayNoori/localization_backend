import type { FastifyInstance } from "fastify";
import { healthRoute } from "./health.route.js";
import { ttsRoute } from "./tts.route.js";
import { translationRoute } from "./translation.route.js";
import { jobsRoute } from "./jobs.route.js";
import { lessonsRoute } from "./lessons.route.js";
import { languageVoiceSettingsRoute } from "./language-voice-settings.route.js";
import { languageGlossaryRoute } from "./language-glossary.route.js";
import { coursesRoute } from "./courses.route.js";
import { segmentsRoute } from "./segments.route.js";

export async function routes(app: FastifyInstance) {
  await app.register(healthRoute);
  await app.register(ttsRoute);
  await app.register(translationRoute);
  await app.register(jobsRoute);
  await app.register(lessonsRoute);
  await app.register(languageVoiceSettingsRoute);
  await app.register(languageGlossaryRoute);
  await app.register(coursesRoute);
  await app.register(segmentsRoute);
}
