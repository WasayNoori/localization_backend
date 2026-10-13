export class CachingSecretsProvider {
    inner;
    cache = new Map();
    constructor(inner) {
        this.inner = inner;
    }
    getSecret(name) {
        const cached = this.cache.get(name);
        if (cached) {
            return cached;
        }
        const pending = this.inner.getSecret(name).catch((err) => {
            this.cache.delete(name);
            throw err;
        });
        this.cache.set(name, pending);
        return pending;
    }
}
//# sourceMappingURL=cachingSecretsProvider.js.map