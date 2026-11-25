import type { RedoxEnvironment } from '../ports.js';

/** Public Redox API host; the data model endpoint is `${REDOX_API_BASE_URL}/endpoint`. */
export const REDOX_API_BASE_URL = 'https://api.redoxengine.com';

export type EhrProvider = 'redox';

export interface EhrConfig {
  readonly provider: EhrProvider;
  readonly redoxEnv: RedoxEnvironment;
}

const ENVIRONMENTS: readonly RedoxEnvironment[] = ['development', 'staging', 'production'];

/**
 * Reads `EHR_PROVIDER` and `REDOX_ENV`. Only non-secret settings come from the environment;
 * Redox credentials live in the practice's vault path (see `CredentialProvider`).
 */
export function loadEhrConfig(env: Readonly<Record<string, string | undefined>>): EhrConfig {
  const provider = env.EHR_PROVIDER ?? 'redox';
  if (provider !== 'redox') {
    throw new Error(`EHR_PROVIDER must be "redox" (got "${provider}").`);
  }
  const redoxEnv = env.REDOX_ENV;
  if (!redoxEnv || !ENVIRONMENTS.includes(redoxEnv as RedoxEnvironment)) {
    throw new Error(`REDOX_ENV must be one of ${ENVIRONMENTS.join(', ')}.`);
  }
  return { provider, redoxEnv: redoxEnv as RedoxEnvironment };
}
