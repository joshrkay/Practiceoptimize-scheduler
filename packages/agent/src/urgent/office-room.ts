import type { OfficeSchedulePort, RoomSlot, SignedUrgentOrder } from './ports.js';

export type OfficeRoomOutcome =
  | { readonly kind: 'booked'; readonly slot: RoomSlot; readonly appointmentId: string }
  | { readonly kind: 'room_full'; readonly offeredSlots: readonly RoomSlot[] };

/** How many open slots to look at on the requested date before deciding the room is full. */
const SAME_DAY_LOOKAHEAD = 50;

/**
 * Books the next open office procedure room slot on the signed order's date. Only open slots are booked, so no
 * scheduled case is ever moved or cancelled; a slot taken in a race falls through to the next one. When the room
 * is full that day, returns the next open slots to offer instead.
 */
export async function bookOfficeRoom(
  schedule: OfficeSchedulePort,
  order: SignedUrgentOrder,
  now: Date,
  offeredSlotCount: number,
): Promise<OfficeRoomOutcome> {
  if (order.siteOfService.kind !== 'office') {
    throw new Error('bookOfficeRoom requires an office site of service');
  }
  const { locationId, roomId } = order.siteOfService;
  const query = {
    practiceId: order.practiceId,
    locationId,
    roomId,
    onOrAfter: order.date,
    notBefore: now,
    durationMinutes: order.durationMinutes,
  };

  const candidates = await schedule.findOpenSlots({ ...query, limit: SAME_DAY_LOOKAHEAD });
  const tried = new Set<string>();
  for (const slot of candidates) {
    if (slot.date !== order.date) break;
    tried.add(slot.slotId);
    const result = await schedule.bookSlot({
      practiceId: order.practiceId,
      slotId: slot.slotId,
      caseId: order.caseId,
      patientId: order.patientId,
      surgeonId: order.surgeonId,
      procedureCode: order.procedure.code,
    });
    if (result.ok) return { kind: 'booked', slot, appointmentId: result.appointmentId };
  }

  const next = await schedule.findOpenSlots({ ...query, limit: offeredSlotCount + tried.size });
  return { kind: 'room_full', offeredSlots: next.filter((s) => !tried.has(s.slotId)).slice(0, offeredSlotCount) };
}
