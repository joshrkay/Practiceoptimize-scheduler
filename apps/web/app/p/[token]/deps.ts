import type { PatientPageService } from '../../../../api/src/patient-page/service';

/**
 * The page renders from an injected service, so the web app never touches stores or ports.
 * The API wiring calls `setPatientPageDeps` at startup; tests pass fakes.
 */
export interface PatientPageDeps {
  service: Pick<
    PatientPageService,
    'inspectLink' | 'verify' | 'requestNewLink' | 'viewCase' | 'saveContactPreferences' | 'chooseSlot'
  >;
  /** `FEATURE_PATIENT_CASE_PAGE`; false means the page does not exist. */
  isEnabled: () => boolean;
}

let current: PatientPageDeps | null = null;

export function setPatientPageDeps(deps: PatientPageDeps | null): void {
  current = deps;
}

export function getPatientPageDeps(): PatientPageDeps | null {
  return current;
}

export function featureFlagEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env['FEATURE_PATIENT_CASE_PAGE'] === 'true';
}

export const SESSION_COOKIE = 'patient_page_session';
