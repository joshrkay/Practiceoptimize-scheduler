# @scheduler/integrations-messaging

Compliance core for automated patient messaging (SMS, email, portal, voice) behind a
`MessagingProvider` port. No vendor is chosen; only the in-memory fake is implemented.

Rules enforced: a consent record per channel is required, STOP opts out of every automated channel
(see `channelsOptedOutByStop`), quiet hours in the patient's time zone (held, then released),
sender identity from the case's location, "automated assistant" on every message, no diagnosis or
procedure names in SMS and voice, delivery status with fallback (SMS, email, portal), and
authorized-contact message-type limits.
