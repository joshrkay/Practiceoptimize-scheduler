import type {
  Facility,
  Location,
  Organization,
  Practice,
  PracticeFacilitySettings,
  PracticeId,
  Surgeon,
} from './model.js';
import type { PracticeRepository } from './repository.js';

/** A whole practice as JSON: the shape of `tests/fixtures/tenancy/*.json`. Ids are fixed so tests can refer to them. */
export interface PracticeFixture {
  readonly organization: Organization | null;
  readonly practice: Practice;
  readonly locations: readonly Location[];
  /** Shared facilities. Seeding skips any that already exist. */
  readonly facilities: readonly Facility[];
  readonly facilitySettings: readonly PracticeFacilitySettings[];
  readonly surgeons: readonly Surgeon[];
}

const LIST_KEYS = ['locations', 'facilities', 'facilitySettings', 'surgeons'] as const;

/**
 * Checks the fixture's top-level shape and that every record belongs to the fixture's practice.
 * Field-level checks (NPI, TIN, time zone) run when the records are written.
 */
export function parsePracticeFixture(json: unknown): PracticeFixture {
  if (typeof json !== 'object' || json === null) throw new Error('Practice fixture must be an object');
  const value = json as Record<string, unknown>;
  const practice = value['practice'] as { id?: unknown } | undefined;
  if (typeof practice?.id !== 'string') throw new Error('Practice fixture needs practice.id');
  for (const key of LIST_KEYS) {
    if (!Array.isArray(value[key])) throw new Error(`Practice fixture needs a "${key}" array`);
  }
  const fixture = { organization: null, ...value } as PracticeFixture;
  const owned = [...fixture.locations, ...fixture.facilitySettings, ...fixture.surgeons];
  if (owned.some((record) => record.practiceId !== practice.id)) {
    throw new Error('Every location, facility setting and surgeon in a practice fixture must carry its practiceId');
  }
  return fixture;
}

/** Writes the fixture through the repository, in dependency order. Returns the practice id. */
export async function seedPracticeFixture(
  repository: PracticeRepository,
  fixture: PracticeFixture,
): Promise<PracticeId> {
  if (fixture.organization && !(await repository.getOrganization(fixture.organization.id))) {
    await repository.createOrganization(fixture.organization);
  }
  const practice = await repository.createPractice(fixture.practice);
  for (const location of fixture.locations) await repository.createLocation(location);
  for (const facility of fixture.facilities) {
    if (!(await repository.getFacility(facility.id))) await repository.createFacility(facility);
  }
  for (const settings of fixture.facilitySettings) await repository.savePracticeFacilitySettings(settings);
  for (const surgeon of fixture.surgeons) await repository.createSurgeon(surgeon);
  return practice.id;
}
