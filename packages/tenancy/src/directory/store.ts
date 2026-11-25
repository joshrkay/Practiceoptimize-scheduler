import type { Channel, Party } from './model';

export interface DirectoryStore {
  /** Returns the practice's own party or a shared one; never another practice's party. */
  get(practiceId: string, partyId: string): Promise<Party | undefined>;
  list(practiceId: string): Promise<Party[]>;
  put(party: Party): Promise<void>;
}

export class InMemoryDirectoryStore implements DirectoryStore {
  private readonly parties = new Map<string, Party>();

  constructor(parties: readonly Party[] = []) {
    for (const p of parties) this.parties.set(p.id, p);
  }

  get(practiceId: string, partyId: string): Promise<Party | undefined> {
    const p = this.parties.get(partyId);
    return Promise.resolve(p && (p.practiceId === null || p.practiceId === practiceId) ? p : undefined);
  }

  list(practiceId: string): Promise<Party[]> {
    return Promise.resolve(
      [...this.parties.values()].filter((p) => p.practiceId === null || p.practiceId === practiceId),
    );
  }

  put(party: Party): Promise<void> {
    const existing = this.parties.get(party.id);
    if (existing && existing.practiceId !== party.practiceId) {
      return Promise.reject(new Error('party id belongs to a different owner'));
    }
    this.parties.set(party.id, party);
    return Promise.resolve();
  }
}

/** Record a human verification of a channel address. */
export async function verifyEndpoint(
  store: DirectoryStore,
  input: {
    practiceId: string;
    partyId: string;
    channel: Channel;
    address: string;
    verifiedBy: string;
    verifiedAt: Date;
  },
): Promise<Party> {
  const party = await store.get(input.practiceId, input.partyId);
  if (!party) throw new Error('party not found');
  const updated: Party = {
    ...party,
    endpoints: {
      ...party.endpoints,
      [input.channel]: {
        address: input.address,
        verification: { status: 'verified', verifiedBy: input.verifiedBy, verifiedAt: input.verifiedAt.toISOString() },
      },
    },
  };
  await store.put(updated);
  return updated;
}
