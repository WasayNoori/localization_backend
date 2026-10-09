// src/modules/monday-outline/index.ts
// Monday outline import — detachable (see README.md). Plugged in with one line
// in app.ts: `await app.register(mondayOutlineModule)`.
import type { FastifyInstance } from "fastify";
import { mondayOutlineRoutes } from "./mondayOutline.route.js";

export async function mondayOutlineModule(app: FastifyInstance): Promise<void> {
  await app.register(mondayOutlineRoutes);
}
