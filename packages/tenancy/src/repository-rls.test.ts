import { readFileSync } from 'node:fs';
import { APP_ROLE, createTestSchema, withPracticeTransaction, type TestSchema } from '@scheduler/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parsePracticeFixture, seedPracticeFixture, type PracticeFixture } from './fixture.js';
import type { PracticeId } from './model.js';
import { createPracticeRepository } from './repository.js';

const fixture: PracticeFixture = parsePracticeFixture(
  JSON.parse(
    readFileSync(new URL('../../../tests/fixtures/tenancy/podiatry-group-3-locations.json', import.meta.url), 'utf8'),
  ),
);
const OTHER = '20000000-0000-4000-8000-0000000000c3' as PracticeId;

describe('practice repository under row-level security (RAH-10)', () => {
  let db: TestSchema;
  let app: ReturnType<TestSchema['pool']>;

  beforeAll(async () => {
    db = await createTestSchema('tenancy_rls');
    app = db.pool({ role: APP_ROLE });
    // Provisioning runs as the schema owner; application reads run as the application role.
    const owner = createPracticeRepository(db.ownerPool);
    await seedPracticeFixture(owner, fixture);
    await owner.createPractice({
      id: OTHER,
      organizationId: null,
      name: 'Other Podiatry',
      isCoveredEntity: true,
      baaStatus: 'not_started',
      baaSignedOn: null,
      availityCustomerId: null,
    });
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('loads the practice through a practice-scoped transaction', async () => {
    const practiceId = fixture.practice.id;
    const [locations, surgeons, facilities, org] = await withPracticeTransaction(app, practiceId, async (tx) => {
      const repo = createPracticeRepository(tx);
      // One connection runs one query at a time, so these run in sequence.
      return [
        await repo.listLocations(practiceId),
        await repo.listSurgeons(practiceId),
        await repo.listPracticeFacilities(practiceId),
        await repo.getOrganization(fixture.organization!.id),
      ] as const;
    });
    expect(locations).toHaveLength(3);
    expect(surgeons).toHaveLength(4);
    expect(facilities).toHaveLength(2);
    expect(org?.name).toBe('Southwest Foot Health Partners');
  });

  it("sees nothing of another practice even when asking for it by id", async () => {
    const practiceId = fixture.practice.id;
    const result = await withPracticeTransaction(app, OTHER, async (tx) => {
      const repo = createPracticeRepository(tx);
      return {
        practice: await repo.getPractice(practiceId),
        locations: await repo.listLocations(practiceId),
        surgeon: await repo.getSurgeon(practiceId, fixture.surgeons[0]!.id),
        facility: await repo.getPracticeFacility(practiceId, fixture.facilities[0]!.id),
        organization: await repo.getOrganization(fixture.organization!.id),
        sharedFacility: await repo.getFacility(fixture.facilities[0]!.id),
      };
    });
    expect(result).toMatchObject({
      practice: null,
      locations: [],
      surgeon: null,
      facility: null,
      organization: null,
    });
    expect(result.sharedFacility?.name).toBe(fixture.facilities[0]!.name);
  });

  it('cannot create a location for another practice', async () => {
    await expect(
      withPracticeTransaction(app, OTHER, (tx) =>
        createPracticeRepository(tx).createLocation({ ...fixture.locations[0]!, id: undefined } as never),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
