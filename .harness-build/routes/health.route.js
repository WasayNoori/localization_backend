export async function healthRoute(app) {
    app.get("/health", {
        schema: {
            description: "Liveness check — always returns { status: \"ok\" }, no dependencies checked.",
            tags: ["health"],
            response: {
                200: {
                    type: "object",
                    properties: {
                        status: { type: "string" },
                    },
                },
            },
        },
    }, async () => ({ status: "ok" }));
}
//# sourceMappingURL=health.route.js.map