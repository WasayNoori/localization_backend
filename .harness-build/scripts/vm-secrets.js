// VM-only launcher shim: dummy secrets without loading @azure/identity (slow over the mount).
import { CachingSecretsProvider } from "../services/secrets/cachingSecretsProvider.js";
import { DummySecretsProvider } from "../services/secrets/dummySecretsProvider.js";
export const buildSecretsProvider = () => new CachingSecretsProvider(new DummySecretsProvider());
