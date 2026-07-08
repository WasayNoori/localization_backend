import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";

declare module "fastify" {
  interface FastifyInstance {
    // decorate with concrete service implementations as they're built,
    // e.g. secretsProvider: ISecretsProvider, nlpService: INlpService, ...
  }
}

export const container = fp(async (app: FastifyInstance) => {
  // build every service here and decorate the instance:
  // const secretsProvider = new EnvSecretsProvider();
  // app.decorate("secretsProvider", secretsProvider);
});
