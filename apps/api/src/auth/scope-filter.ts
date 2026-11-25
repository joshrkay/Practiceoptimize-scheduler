import type { Scope } from './roles';
import type { Session } from './session';

export interface ScopedRow {
  readonly practiceId: string;
  readonly locationId?: string | null;
  readonly surgeonId?: string | null;
}

type ScopeHolder = Pick<Session, 'practiceId' | 'scope'>;

/** True when the row belongs to the session's practice and falls inside its scope. Fails closed. */
export function isInScope(session: ScopeHolder, row: ScopedRow): boolean {
  if (row.practiceId !== session.practiceId) return false;
  const scope: Scope = session.scope;
  switch (scope.kind) {
    case 'practice':
      return true;
    case 'locations':
      return row.locationId != null && scope.locationIds.includes(row.locationId);
    case 'surgeons':
      return row.surgeonId != null && scope.surgeonIds.includes(row.surgeonId);
    default:
      return false;
  }
}

export function filterByScope<T extends ScopedRow>(session: ScopeHolder, rows: readonly T[]): T[] {
  return rows.filter((row) => isInScope(session, row));
}

export interface SqlClause {
  readonly sql: string;
  readonly params: readonly unknown[];
}

const IDENT = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;

/**
 * Parameterised predicate to AND onto a query, on top of row-level security (which keys on practice).
 * The practice column is always constrained too. Placeholders start at startIndex (1-based).
 */
export function scopeSqlClause(
  session: ScopeHolder,
  columns: { practice: string; location: string; surgeon: string },
  startIndex = 1,
): SqlClause {
  for (const c of Object.values(columns)) {
    if (!IDENT.test(c)) throw new Error(`unsafe column name: ${c}`);
  }
  const p = `$${startIndex}`;
  const q = `$${startIndex + 1}`;
  const base = `${columns.practice} = ${p}`;
  const scope = session.scope;
  switch (scope.kind) {
    case 'practice':
      return { sql: base, params: [session.practiceId] };
    case 'locations':
      return { sql: `${base} AND ${columns.location} = ANY(${q})`, params: [session.practiceId, [...scope.locationIds]] };
    case 'surgeons':
      return { sql: `${base} AND ${columns.surgeon} = ANY(${q})`, params: [session.practiceId, [...scope.surgeonIds]] };
    default:
      return { sql: 'false', params: [] };
  }
}
