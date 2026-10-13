import fp from "fastify-plugin";
export const auth = fp(async (app) => {
    app.addHook("onRequest", async (request, reply) => {
        if (request.url.startsWith("/docs")) {
            return;
        }
        const apiKey = request.headers["x-api-key"];
        if (apiKey !== app.secrets.apiKey) {
            reply.code(401).send({ error: "Unauthorized" });
        }
    });
});
//# sourceMappingURL=auth.js.map