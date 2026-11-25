import { readFileSync } from 'node:fs';
import { createTestSchema, type TestSchema } from '@scheduler/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parsePracticeFixture, seedPracticeFixture, type PracticeFixture } from './fixture.js';
import type { FacilityId, LocationId, OrganizationId, PracticeId, SurgeonId } from './model.js';
import { createPracticeRepository, type NewLocation, type PracticeRepository } from './repository.js';
import { PracticeDataError } from './validation.js';

const fixtureJson: unknown = JSON.parse(
  readFileSync(new URL('../../../tests/fixtures/tenancy/podiatry-group-3-locations.json', import.meta.url), 'utf8'),
);

const OTHER_PRACTICE = '20000000-0000-4000-8000-0000000000b2' as PracticeId;

describe('practice model (RAH-9)', () => {
  let db: TestSchema;
  let repo: PracticeRepository;
  let fixture: PracticeFixture;
  let practiceId: PracticeId;

  beforeAll(async () => {
    db = await createTestSchema('tenancy');
    repo = createPracticeRepository(db.ownerPool);
    fixture = parsePracticeFixture(fixtureJson);
    practiceId = await seedPracticeFixture(repo, fixture);
  });

  afterAll(async () => {
    await db?.drop();
  });

  const capitalAsc = () => fixture.facilities[0]!.id;
  const austin = () => fixture.locations[0]!;

  describe('Scenario 1: multi-location practice loads', () => {
    it('returns each location with its own NPI, TIN, time zone and state', async () => {
      const locations = await repo.listLocations(practiceId);
      expect(locations).toHaveLength(3);
      const byName = Object.fromEntries(locations.map((l) => [l.name, l]));
      expect(byName['Austin Central Office']).toMatchObject({
        billingNpi: '1999000015',
        billingTin: '741234501',
        timeZone: 'America/Chicago',
        address: { state: 'TX', line2: 'Suite 200' },
      });
      expect(byName['El Paso West Office']).toMatchObject({
        billingNpi: '1999000023',
        billingTin: '741234502',
        timeZone: 'America/Denver',
        address: { state: 'TX' },
        smsNumber: null,
      });
      expect(byName['Albuquerque Uptown Office']).toMatchObject({
        billingNpi: '1999000031',
        billingTin: '851234503',
        timeZone: 'America/Denver',
        address: { state: 'NM' },
      });
      expect(new Set(locations.map((l) => l.address.state))).toEqual(new Set(['TX', 'NM']));
      expect(byName['Austin Central Office']?.hours.fri).toEqual({ open: '08:00', close: '12:00' });
    });

    it('resolves all 4 surgeons to the practice with their locations and privileges', async () => {
      const surgeons = await repo.listSurgeons(practiceId);
      expect(surgeons).toHaveLength(4);
      expect(surgeons.every((s) => s.practiceId === practiceId)).toBe(true);
      const casey = surgeons.find((s) => s.lastName === 'Mockford');
      expect(casey?.locationIds).toEqual(['30000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000003']);
      expect(casey?.facilityPrivileges).toEqual([
        { facilityId: '40000000-0000-4000-8000-000000000001', status: 'pending', expiresOn: null },
        { facilityId: '40000000-0000-4000-8000-000000000002', status: 'active', expiresOn: '2027-06-30' },
      ]);
    });

    it('loads the practice under its parent organization', async () => {
      const practice = await repo.getPractice(practiceId);
      expect(practice).toMatchObject({
        organizationId: '10000000-0000-4000-8000-000000000001',
        baaStatus: 'signed',
        baaSignedOn: '2026-10-01',
        availityCustomerId: 'AV-TEST-000101',
        isCoveredEntity: true,
      });
      const org = await repo.getOrganization(practice!.organizationId!);
      expect(org?.name).toBe('Southwest Foot Health Partners');
    });

    it('lists the 2 ASCs the practice operates at with its own settings', async () => {
      const facilities = await repo.listPracticeFacilities(practiceId);
      expect(facilities.map((f) => f.facility.facilityType)).toEqual(['asc', 'asc']);
      const capital = facilities.find((f) => f.facility.id === capitalAsc());
      expect(capital?.settings).toMatchObject({ postingMethod: 'fax', rules: { postingLeadDays: 7 } });
      expect(capital?.settings.blockSchedules).toHaveLength(1);
    });
  });

  describe('Scenario 2: shared facility', () => {
    beforeAll(async () => {
      await repo.createPractice({
        id: OTHER_PRACTICE,
        organizationId: null,
        name: 'Riverbend Podiatry',
        isCoveredEntity: true,
        baaStatus: 'sent',
        baaSignedOn: null,
        availityCustomerId: null,
      });
      await repo.savePracticeFacilitySettings({
        practiceId: OTHER_PRACTICE,
        facilityId: capitalAsc(),
        orDeskContacts: [{ name: 'Jordan Sample', role: 'Charge nurse', phone: '+15125550130', fax: null, email: null }],
        postingMethod: 'email',
        blockSchedules: [],
        rules: {},
      });
    });

    it('keeps one facility record and gives each practice only its own settings', async () => {
      const count = await db.ownerPool.query('SELECT 1 FROM facilities WHERE id = $1', [capitalAsc()]);
      expect(count.rowCount).toBe(1);

      const mine = await repo.getPracticeFacility(practiceId, capitalAsc());
      const theirs = await repo.getPracticeFacility(OTHER_PRACTICE, capitalAsc());
      expect(mine?.facility).toEqual(theirs?.facility);
      expect(mine?.settings.orDeskContacts.map((c) => c.name)).toEqual(['Pat Example']);
      expect(theirs?.settings.orDeskContacts.map((c) => c.name)).toEqual(['Jordan Sample']);
      expect(theirs?.settings.postingMethod).toBe('email');

      const theirList = await repo.listPracticeFacilities(OTHER_PRACTICE);
      expect(theirList.map((f) => f.settings.practiceId)).toEqual([OTHER_PRACTICE]);
    });

    it('updates a practice’s settings in place without touching the other practice', async () => {
      await repo.savePracticeFacilitySettings({
        practiceId: OTHER_PRACTICE,
        facilityId: capitalAsc(),
        orDeskContacts: [{ name: 'Robin Example', role: 'OR desk', phone: null, fax: '+15125550131', email: null }],
        postingMethod: 'fax',
        blockSchedules: [{ surgeonId: null, weekday: 'mon', start: '07:00', end: '11:00' }],
        rules: { postingLeadDays: 3 },
      });
      const theirs = await repo.getPracticeFacility(OTHER_PRACTICE, capitalAsc());
      expect(theirs?.settings).toMatchObject({ postingMethod: 'fax', rules: { postingLeadDays: 3 } });
      const mine = await repo.getPracticeFacility(practiceId, capitalAsc());
      expect(mine?.settings.postingMethod).toBe('fax');
      expect(mine?.settings.orDeskContacts[0]?.name).toBe('Pat Example');
    });

    it('never returns another practice’s location or surgeon, even by id', async () => {
      expect(await repo.getLocation(OTHER_PRACTICE, austin().id)).toBeNull();
      expect(await repo.getSurgeon(OTHER_PRACTICE, fixture.surgeons[0]!.id)).toBeNull();
      expect(await repo.listSurgeons(OTHER_PRACTICE)).toEqual([]);
    });

    it('refuses to link a surgeon to another practice’s location or to a facility it does not use', async () => {
      const base = {
        practiceId: OTHER_PRACTICE,
        npi: '1999000312',
        firstName: 'Quinn',
        lastName: 'Crosslink',
        specialty: 'podiatry',
      };
      await expect(
        repo.createSurgeon({ ...base, locationIds: [austin().id], facilityPrivileges: [] }),
      ).rejects.toThrow(/foreign key/);

      const location = await repo.createLocation({
        ...austin(),
        id: undefined,
        practiceId: OTHER_PRACTICE,
        name: 'Riverbend Main',
      } as unknown as NewLocation);
      await expect(
        repo.createSurgeon({
          ...base,
          locationIds: [location.id],
          facilityPrivileges: [
            { facilityId: fixture.facilities[1]!.id, status: 'active', expiresOn: null },
          ],
        }),
      ).rejects.toThrow(/foreign key/);
      expect(await repo.listSurgeons(OTHER_PRACTICE)).toEqual([]);
    });
  });

  describe('validation', () => {
    it('rejects bad location identity fields before writing', async () => {
      const bad = { ...austin(), id: undefined, billingNpi: '1234567890', billingTin: '12', timeZone: 'Nowhere' };
      const error = await repo.createLocation(bad as unknown as NewLocation).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PracticeDataError);
      expect((error as PracticeDataError).issues).toHaveLength(3);
      await expect(
        repo.createLocation({
          ...austin(),
          id: undefined,
          address: { ...austin().address, state: 'ZZ', postalCode: 'ABCDE', line1: ' ', city: '' },
          hours: { mon: { open: '17:00', close: '08:00' }, fun: { open: '08:00', close: '09:00' } },
        } as unknown as NewLocation),
      ).rejects.toThrow(/state code.*ZIP.*line 1.*city|line 1/);
    });

    it('rejects a signed BAA without a date, hospitals, bad settings and surgeons without a location', async () => {
      await expect(
        repo.createPractice({
          organizationId: null,
          name: 'No Date Podiatry',
          isCoveredEntity: true,
          baaStatus: 'signed',
          baaSignedOn: null,
          availityCustomerId: null,
        }),
      ).rejects.toThrow(/signed date/);
      await expect(
        repo.createFacility({
          ...fixture.facilities[0]!,
          id: undefined,
          npi: '1234567890',
          facilityType: 'hospital',
        } as never),
      ).rejects.toThrow(/unsupported facility type.*NPI/);
      await expect(
        repo.savePracticeFacilitySettings({
          ...fixture.facilitySettings[0]!,
          postingMethod: 'carrier_pigeon' as never,
          orDeskContacts: [{ name: '', role: 'x', phone: null, fax: null, email: null }],
          blockSchedules: [{ surgeonId: null, weekday: 'sun', start: '12:00', end: '09:00' }],
        }),
      ).rejects.toThrow(PracticeDataError);
      await expect(
        repo.createSurgeon({
          ...fixture.surgeons[0]!,
          id: undefined,
          npi: '1999000312',
          locationIds: [],
          facilityPrivileges: [{ facilityId: capitalAsc(), status: 'revoked', expiresOn: '31/12/2027' }],
        } as never),
      ).rejects.toThrow(/at least one location/);
    });

    it('creates records with generated ids and returns null for unknown ids', async () => {
      const org = await repo.createOrganization({ name: 'Generated Org' });
      expect(org.id).toMatch(/^[0-9a-f-]{36}$/);
      const facility = await repo.createFacility({ ...fixture.facilities[1]!, id: undefined, npi: null, name: 'Generated ASC' } as never);
      expect(facility.npi).toBeNull();
      const missing = '99999999-0000-4000-8000-000000000000';
      expect(await repo.getOrganization(missing as OrganizationId)).toBeNull();
      expect(await repo.getPractice(missing as PracticeId)).toBeNull();
      expect(await repo.getFacility(missing as FacilityId)).toBeNull();
      expect(await repo.getLocation(practiceId, missing as LocationId)).toBeNull();
      expect(await repo.getSurgeon(practiceId, missing as SurgeonId)).toBeNull();
      expect(await repo.getPracticeFacility(practiceId, missing as FacilityId)).toBeNull();
    });
  });
});

describe('parsePracticeFixture', () => {
  it('rejects malformed fixtures', () => {
    expect(() => parsePracticeFixture(null)).toThrow(/must be an object/);
    expect(() => parsePracticeFixture({})).toThrow(/practice\.id/);
    expect(() => parsePracticeFixture({ practice: { id: 'p' }, locations: [] })).toThrow(/"facilities" array/);
    expect(() =>
      parsePracticeFixture({
        practice: { id: 'p' },
        locations: [{ practiceId: 'someone-else' }],
        facilities: [],
        facilitySettings: [],
        surgeons: [],
      }),
    ).toThrow(/must carry its practiceId/);
  });

  it('defaults the organization to null', () => {
    const parsed = parsePracticeFixture({
      practice: { id: 'p' },
      locations: [],
      facilities: [],
      facilitySettings: [],
      surgeons: [],
    });
    expect(parsed.organization).toBeNull();
  });
});
