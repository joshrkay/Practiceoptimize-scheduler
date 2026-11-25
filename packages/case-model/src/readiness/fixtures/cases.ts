/** Synthetic podiatry cases from `tests/fixtures/readiness/`. */
import bunionectomyAscDiabetic from '../../../../../tests/fixtures/readiness/bunionectomy-asc-diabetic.json';
import flatfootReconAscSmoker from '../../../../../tests/fixtures/readiness/flatfoot-recon-asc-smoker.json';
import neuromaOfficeLocal from '../../../../../tests/fixtures/readiness/neuroma-office-local.json';
import selfPayCosmeticToe from '../../../../../tests/fixtures/readiness/self-pay-cosmetic-toe.json';
import type { ReadinessCase } from '../ports.js';

function asCase(json: object, overrides: Partial<ReadinessCase>): ReadinessCase {
  return { ...(json as ReadinessCase), ...overrides };
}

export const fixtureCases = {
  neuromaOfficeLocal: (overrides: Partial<ReadinessCase> = {}) => asCase(neuromaOfficeLocal, overrides),
  bunionectomyAscDiabetic: (overrides: Partial<ReadinessCase> = {}) => asCase(bunionectomyAscDiabetic, overrides),
  flatfootReconAscSmoker: (overrides: Partial<ReadinessCase> = {}) => asCase(flatfootReconAscSmoker, overrides),
  selfPayCosmeticToe: (overrides: Partial<ReadinessCase> = {}) => asCase(selfPayCosmeticToe, overrides),
};
