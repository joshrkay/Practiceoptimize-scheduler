export const ROLES = ['practice_admin', 'scheduler', 'auth_specialist', 'read_only', 'vendor_support'] as const;
export type Role = (typeof ROLES)[number];

/** Every role requires MFA; the table exists so a change is explicit and tested. */
export const ROLE_MFA_REQUIRED: Readonly<Record<Role, boolean>> = {
  practice_admin: true,
  scheduler: true,
  auth_specialist: true,
  read_only: true,
  vendor_support: true,
};

export type PracticeId = string;

/** What a user may see: the whole practice, a set of locations, or a surgeon panel. */
export type Scope =
  | { readonly kind: 'practice' }
  | { readonly kind: 'locations'; readonly locationIds: readonly string[] }
  | { readonly kind: 'surgeons'; readonly surgeonIds: readonly string[] };

export class InvalidScopeError extends Error {}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** Returns a frozen, de-duplicated copy. Empty sets are rejected: they would silently grant nothing. */
export function normalizeScope(scope: Scope): Scope {
  switch (scope.kind) {
    case 'practice':
      return Object.freeze({ kind: 'practice' });
    case 'locations': {
      const ids = [...new Set(scope.locationIds)];
      if (ids.length === 0) throw new InvalidScopeError('location scope needs at least one location');
      return Object.freeze({ kind: 'locations', locationIds: Object.freeze(ids) });
    }
    case 'surgeons': {
      const ids = [...new Set(scope.surgeonIds)];
      if (ids.length === 0) throw new InvalidScopeError('surgeon scope needs at least one surgeon');
      return Object.freeze({ kind: 'surgeons', surgeonIds: Object.freeze(ids) });
    }
    default:
      throw new InvalidScopeError('unknown scope kind');
  }
}

export function mfaRequiredFor(role: Role): boolean {
  return ROLE_MFA_REQUIRED[role];
}
