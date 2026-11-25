import type {
  IdentityAssertion,
  IdentityProvider,
  LoginCallback,
  LoginRedirect,
  UserDirectory,
  UserGrant,
} from './ports';
import type { PracticeId } from './roles';

export class FakeIdentityProvider implements IdentityProvider {
  private readonly pending = new Map<string, PracticeId>();
  private readonly outcomes = new Map<string, Omit<IdentityAssertion, 'practiceId'>>();
  private counter = 0;

  /** Script what the IdP will return for a code. */
  setOutcome(code: string, outcome: Omit<IdentityAssertion, 'practiceId'>): void {
    this.outcomes.set(code, outcome);
  }

  beginLogin(practiceId: PracticeId): Promise<LoginRedirect> {
    const state = `state-${++this.counter}`;
    this.pending.set(state, practiceId);
    return Promise.resolve({ redirectUrl: `https://idp.example.test/login?state=${state}`, state });
  }

  completeLogin(callback: LoginCallback): Promise<IdentityAssertion> {
    const practiceId = this.pending.get(callback.state);
    const outcome = this.outcomes.get(callback.code);
    if (practiceId === undefined || outcome === undefined) {
      return Promise.reject(new Error('invalid login callback'));
    }
    this.pending.delete(callback.state);
    return Promise.resolve({ ...outcome, practiceId });
  }
}

export class InMemoryUserDirectory implements UserDirectory {
  private readonly grants = new Map<string, UserGrant>();

  add(practiceId: PracticeId, subject: string, grant: UserGrant): void {
    this.grants.set(`${practiceId}\u0000${subject}`, grant);
  }

  findGrant(practiceId: PracticeId, subject: string): Promise<UserGrant | null> {
    return Promise.resolve(this.grants.get(`${practiceId}\u0000${subject}`) ?? null);
  }
}
