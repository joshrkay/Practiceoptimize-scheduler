# @scheduler/integrations-payments

Hosted payment links and payment confirmations through the practice's own processor (ADR-0008).

- One `PaymentProcessor` adapter interface: create hosted link, link status, verify and parse webhook.
- A generic `PaymentService`: per-practice processor selection, credentials through `CredentialProvider`,
  per-practice HMAC signature verification, idempotency by processor event ID, deposit confirmation
  through `DepositConfirmationPort` (RAH-90), reminder then scheduler task for expired or failed links,
  processor-reported refunds recorded.
- An in-memory fake processor for tests.

We never receive, store or log card data, and the agent never initiates refunds. Real Stripe, Square or
healthcare-processor adapters are deferred until a practice's processor is known.
