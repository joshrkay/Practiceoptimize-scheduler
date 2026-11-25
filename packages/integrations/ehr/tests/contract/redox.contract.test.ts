import { REDOX_OPERATIONS, supportedCapabilities, PILOT_CAPABILITY_MATRIX, type EhrCapability } from '../../src/index.js';
import { buildRedoxPractice, PRACTICE } from '../support/redox-harness.js';
import { describeEhrConnectorContract } from './ehr-connector-contract.js';

/** Supported for Redox = the EHR's matrix row AND the Redox operation is implemented. */
const expectedFor = (ehr: keyof typeof PILOT_CAPABILITY_MATRIX): ReadonlySet<EhrCapability> =>
  new Set(
    [...supportedCapabilities(PILOT_CAPABILITY_MATRIX[ehr])].filter((c) => REDOX_OPERATIONS[c].status === 'implemented'),
  );

for (const ehr of ['athenahealth', 'eclinicalworks', 'nextgen'] as const) {
  describeEhrConnectorContract(`Redox (${ehr} fixtures)`, () => {
    const { connector, sets } = buildRedoxPractice();
    const set = sets.find((s) => s.ehr === ehr)!;
    return {
      connector,
      ctx: { practiceId: PRACTICE, locationId: `loc-${ehr}` },
      expected: { ehr, supported: expectedFor(ehr) },
      fixture: {
        patientId: set.patientId,
        missingPatientId: 'no-such-patient',
        phiMarkers: set.phiMarkers,
        minOrders: 1,
        providerId: 'prov-1',
        window: { from: '2027-02-01T13:00:00.000Z', to: '2027-02-08T00:00:00.000Z' },
        inBasketRecipientId: 'pool-front-desk',
      },
    };
  });
}
