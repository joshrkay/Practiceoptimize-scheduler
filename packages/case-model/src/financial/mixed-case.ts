import type { CaseProcedure } from './types.js';

export interface CaseCoverageSplit {
  /** Insured procedures: eligibility and authorization cover only these. */
  readonly authorizationProcedureIds: readonly string[];
  /** Self-pay procedures: the quote covers only these. */
  readonly quoteProcedureIds: readonly string[];
  readonly isMixed: boolean;
  readonly isSelfPayOnly: boolean;
}

export function splitCaseByCoverage(procedures: readonly CaseProcedure[]): CaseCoverageSplit {
  const authorizationProcedureIds = procedures.filter((p) => p.coverage === 'insured').map((p) => p.procedureId);
  const quoteProcedureIds = procedures.filter((p) => p.coverage === 'self_pay').map((p) => p.procedureId);
  return {
    authorizationProcedureIds,
    quoteProcedureIds,
    isMixed: authorizationProcedureIds.length > 0 && quoteProcedureIds.length > 0,
    isSelfPayOnly: authorizationProcedureIds.length === 0 && quoteProcedureIds.length > 0,
  };
}
