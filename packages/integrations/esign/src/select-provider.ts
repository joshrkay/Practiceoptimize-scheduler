import { InMemoryESignProvider } from './fake-provider.js';
import type { ESignProvider } from './types.js';

/**
 * Selects the provider from ESIGN_PROVIDER. Real vendor adapters are deferred until a vendor is
 * chosen; the webhook secret comes from the practice's vault, not the environment.
 */
export function selectProvider(
  providerName: string | undefined,
  webhookSecret: string,
): ESignProvider {
  switch (providerName) {
    case 'fake':
      return new InMemoryESignProvider(webhookSecret);
    case undefined:
    case '':
      throw new Error('ESIGN_PROVIDER is not set');
    default:
      throw new Error(`ESIGN_PROVIDER "${providerName}" has no adapter: no vendor is chosen yet`);
  }
}
