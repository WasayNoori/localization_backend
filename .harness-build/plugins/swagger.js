import fp from "fastify-plugin";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
export const swaggerDocs = fp(async (app) => {
    await app.register(swagger, {
        openapi: {
            info: {
                title: "Localization Backend API",
                version: "0.1.0",
            },
            components: {
                securitySchemes: {
                    apiKey: {
                        type: "apiKey",
                        name: "x-api-key",
                        in: "header",
                    },
                },
            },
            security: [{ apiKey: [] }],
        },
    });
    await app.register(swaggerUi, {
        routePrefix: "/docs",
    });
});
//# sourceMappingURL=swagger.js.map