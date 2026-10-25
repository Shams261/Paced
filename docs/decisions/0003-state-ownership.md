# ADR-0003: State ownership, exclusivity and manual changes

Decision status: Accepted

## Context

Cloud intent must not be mistaken for current LinkedIn truth. One person can be in many lists but must not receive competing campaign sequences. The approved plan removes the 30-day enrollment deadline.

## Decision

Separate connection, enrollment and action states. Cloud owns intent/history; dated observations supply evidence. Enforce one active enrollment per account-recipient including waiting, paused and held. Existing connections cannot enroll for invitations or messages. Pending invitations skip invitation/note and wait without timeout. Incoming replies (including before acceptance), post-enrollment manual outgoing messages and confirmed withdrawal end the sequence. Historical conversation is a baseline. See [data/lifecycle](../architecture/data-lifecycle.md).

Basis: the approved hosted MVP architecture baseline, 30 September 2026. Accepted means selected design, not tested implementation.

## Alternatives and consequences

Per-list deduplication permits competing campaigns; local-only truth drifts across devices. Treating invitation absence as withdrawal or expiring pending enrollments invents certainty. Strong exclusivity reduces campaign flexibility and incomplete observations can hold work indefinitely; stopped/completed work never auto-restarts.

## Validation

Planned verification: Deterministic lifecycle fixtures, concurrent database enrollment tests and read-only identity/conversation/connection evidence gates.

At acceptance this was a documentation decision; no application, infrastructure, browser integration or live LinkedIn validation ran for it. Provider limits are dated research cited in the architecture documents.
