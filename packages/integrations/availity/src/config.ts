import { AvailityConfigError } from './errors.js';

export const AVAILITY_ENVIRONMENTS = ['demo', 'sandbox', 'standard'] as const;
export type AvailityEnvironment = (typeof AVAILITY_ENVIRONMENTS)[number];

export interface AvailityConfig {
  environment: AvailityEnvironment;
  /** No trailing slash. There is no built-in default: the URL comes from AVAILITY_BASE_URL. */
  baseUrl: string;
}

/** Reads AVAILITY_ENV and AVAILITY_BASE_URL. These are configuration, not secrets. */
export function loadAvailityConfig(env: Record<string, string | undefined>): AvailityConfig {
  const rawEnv = env['AVAILITY_ENV'];
  if (!AVAILITY_ENVIRONMENTS.includes(rawEnv as AvailityEnvironment)) {
    throw new AvailityConfigError(`AVAILITY_ENV must be one of ${AVAILITY_ENVIRONMENTS.join(', ')}`);
  }
  const environment = rawEnv as AvailityEnvironment;
  const rawUrl = env['AVAILITY_BASE_URL'];
  if (!rawUrl) throw new AvailityConfigError('AVAILITY_BASE_URL is required');
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AvailityConfigError('AVAILITY_BASE_URL is not a valid URL');
  }
  if (url.protocol !== 'https:' && !(environment === 'demo' && url.protocol === 'http:')) {
    throw new AvailityConfigError('AVAILITY_BASE_URL must use https (http is allowed only in demo)');
  }
  return { environment, baseUrl: rawUrl.replace(/\/+$/, '') };
}
