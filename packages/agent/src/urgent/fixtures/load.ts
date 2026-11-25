/** Loads a synthetic urgent add-on fixture into a fresh set of in-memory fakes. Test support only. */
import { createFakeUrgentAddOnDeps, type FakeUrgentAddOnDeps } from '../fakes.js';
import type { AscFacility, CaseRequest, JourneyRecipient, RoomSlot, SignedUrgentOrder } from '../ports.js';
import ascIncisionDrainage from './asc-incision-drainage.json' with { type: 'json' };
import ascNoConfirmation from './asc-no-confirmation.json' with { type: 'json' };
import officeDebridement from './office-debridement.json' with { type: 'json' };
import officeRoomFull from './office-room-full.json' with { type: 'json' };

export interface UrgentFixture {
  readonly description: string;
  readonly now: string;
  readonly order: SignedUrgentOrder;
  readonly caseRequest: CaseRequest;
  readonly office?: {
    readonly locationId: string;
    readonly slots: readonly { readonly slot: RoomSlot; readonly bookedCaseId: string | null }[];
  };
  readonly asc?: AscFacility;
  readonly ascConfirmation?: { readonly afterMinutes: number; readonly start: string; readonly confirmationNumber: string };
  readonly recipients: readonly JourneyRecipient[];
  readonly payerWindowsHours: Readonly<Record<string, number>>;
}

export const urgentFixtures = {
  officeDebridement: officeDebridement as unknown as UrgentFixture,
  officeRoomFull: officeRoomFull as unknown as UrgentFixture,
  ascIncisionDrainage: ascIncisionDrainage as unknown as UrgentFixture,
  ascNoConfirmation: ascNoConfirmation as unknown as UrgentFixture,
} as const;

export function loadUrgentFixture(fixture: UrgentFixture): FakeUrgentAddOnDeps {
  const deps = createFakeUrgentAddOnDeps(fixture.now);
  const { order } = fixture;
  deps.intake.addOrder(order);
  deps.intake.addCaseRequest(fixture.caseRequest);
  deps.caseState.set(order.practiceId, order.caseId, 'ordered');
  for (const { slot, bookedCaseId } of fixture.office?.slots ?? []) {
    deps.officeSchedule.addSlot(order.practiceId, fixture.office?.locationId ?? '', slot, bookedCaseId);
  }
  if (fixture.asc !== undefined) deps.ascDirectory.add(order.practiceId, fixture.asc);
  deps.messaging.setRecipients(order.practiceId, order.patientId, fixture.recipients);
  for (const [payerId, hours] of Object.entries(fixture.payerWindowsHours)) {
    deps.authorization.windowsHours.set(payerId, hours);
  }
  return deps;
}
