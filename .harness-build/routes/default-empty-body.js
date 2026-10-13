// Body is optional on some POSTs, but Fastify validates a missing body
// against `type: "object"` and rejects it (400 "body must be object") before
// the handler runs — e.g. a frontend fetch POST with no body. Use as a route's
// `preValidation` hook to default it to {}.
export async function defaultEmptyBody(request) {
    request.body ??= {};
}
//# sourceMappingURL=default-empty-body.js.map