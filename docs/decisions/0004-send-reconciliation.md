# ADR-0004: Execution lease and uncertain-send reconciliation

Decision status: Accepted

## Context

Browser termination, network loss and late results can leave a remote send uncertain. A database lease cannot atomically commit an external LinkedIn click.

## Decision

Use stable logical actions, distinct attempts, one account sender, transactional reservations and fenced short-lived authorization. Record may-have-sent in cloud and durable local IndexedDB before click. NOT_SENT needs positive no-send evidence; CONFIRMED_SENT needs positive send evidence; OUTCOME_UNKNOWN blocks retries and next steps. Lost/expired authority after a possible send never reassigns work. Late evidence reconciles without reviving stopped intent. See [contracts](../architecture/api-execution.md).

Basis: the approved hosted MVP architecture baseline, 30 September 2026. Accepted means selected design, not tested implementation.

## Alternatives and consequences

Blind at-least-once retry risks duplicate outreach. Trusting the local journal alone loses evidence on device loss. Claiming exactly-once LinkedIn sends is unsupported. Conservative holds can reduce availability and require operator attention; fresh checks still leave a bounded race with external user changes.

## Validation

Planned verification: Crash and timeout tests at every journal/authorization/click/result boundary, concurrent executor tests, stop/late-result cases and isolated restore drills; live action testing requires separately approved recipient/content scope.

At acceptance this was a documentation decision; no application, infrastructure, browser integration or live LinkedIn validation ran for it. Provider limits are dated research cited in the architecture documents.
