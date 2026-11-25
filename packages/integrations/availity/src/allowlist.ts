import { RequestRefusedError } from './errors.js';

/** Path segments that identify claim submission or remittance APIs. Always refused, allowlist or not. */
const FORBIDDEN_SEGMENTS = new Set([
  'claim',
  'claims',
  'claim-submission',
  'claim-submissions',
  'claimsubmission',
  'claimsubmissions',
  'remittance',
  'remittances',
  'remit',
  'remits',
  'era',
  'eras',
  '835',
]);

export interface EndpointPolicy {
  /**
   * Path prefixes (segment-aligned, e.g. `/v1/coverages`) the client may call. Required: the typed
   * endpoint list comes from the vendored spec, which is not in the repo yet.
   */
  allowedPrefixes: readonly string[];
}

function normalize(path: string): string[] {
  if (!path.startsWith('/') || path.includes('?') || path.includes('#') || path.includes('\\')) {
    throw new RequestRefusedError('Endpoint path must start with "/" and carry no query or fragment');
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new RequestRefusedError('Endpoint path is not valid');
  }
  if (decoded.includes('?') || decoded.includes('#') || decoded.includes('\\')) {
    throw new RequestRefusedError('Endpoint path is not valid');
  }
  const segments = decoded.toLowerCase().split('/').slice(1);
  if (segments.some((s) => s === '..' || s === '.')) {
    throw new RequestRefusedError('Endpoint path must not traverse');
  }
  // Allow one trailing slash.
  if (segments.length > 1 && segments[segments.length - 1] === '') segments.pop();
  return segments;
}

/** Throws RequestRefusedError unless the path is allowed and is not a claim or remittance endpoint. */
export function assertEndpointAllowed(path: string, policy: EndpointPolicy): void {
  const segments = normalize(path);
  if (segments.some((s) => s === '')) throw new RequestRefusedError('Endpoint path has empty segments');
  if (segments.some((s) => FORBIDDEN_SEGMENTS.has(s))) {
    throw new RequestRefusedError('Claim submission and remittance endpoints are not exposed');
  }
  const allowed = policy.allowedPrefixes.some((prefix) => {
    const p = normalize(prefix);
    return p.length <= segments.length && p.every((s, i) => segments[i] === s);
  });
  if (!allowed) throw new RequestRefusedError('Endpoint is not on the allowlist');
}
