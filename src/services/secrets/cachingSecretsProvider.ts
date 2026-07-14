import type { ISecretsProvider } from "../../interfaces/index.js";

export class CachingSecretsProvider implements ISecretsProvider {
  private readonly cache = new Map<string, Promise<string>>();

  constructor(private readonly inner: ISecretsProvider) {}

  getSecret(name: string): Promise<string> {
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
