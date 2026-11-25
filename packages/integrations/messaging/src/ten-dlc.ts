import type { PracticeId } from './types.js';

export type RegistrationStatus = 'not_started' | 'pending' | 'approved' | 'rejected';

/**
 * 10DLC status model only. Registration itself needs a vendor and is not performed here.
 */
export interface TenDlcRegistration {
  practiceId: PracticeId;
  brand: RegistrationStatus;
  campaign: RegistrationStatus;
}

export interface TenDlcRegistry {
  get(practiceId: PracticeId): Promise<TenDlcRegistration | null>;
}

/** SMS may be sent only after both brand and campaign are approved. */
export function canSendSms(registration: TenDlcRegistration | null): boolean {
  return registration?.brand === 'approved' && registration.campaign === 'approved';
}

export class InMemoryTenDlcRegistry implements TenDlcRegistry {
  private readonly map = new Map<PracticeId, TenDlcRegistration>();

  set(registration: TenDlcRegistration): void {
    this.map.set(registration.practiceId, registration);
  }

  get(practiceId: PracticeId): Promise<TenDlcRegistration | null> {
    return Promise.resolve(this.map.get(practiceId) ?? null);
  }
}
