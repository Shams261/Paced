# API and browser execution contracts

Accepted contract design, not a deployed API. [ADR-0004](../decisions/0004-send-reconciliation.md) explains uncertainty handling. Wire details and adapter evidence fixtures remain future implementation gates.

## Authentication and tenant guards

All `/v1` operations require a verified Supabase product token, active allowlist membership and workspace ownership. Server derives the tenant from that token, then checks tenant/account/object ownership on every query and mutation, including exports, observations, claims and late outcomes. Opaque IDs do not grant access. Google OAuth is product sign-in, never LinkedIn login. Executor requests additionally require a revocable device credential bound to user, workspace, account and compatible contract/adapter versions. Registration alone does not verify the current LinkedIn session.

RLS and explicit table/function grants both apply. Prefer user-scoped database access for ordinary operations. Privileged transactional queue/admin paths must explicitly enforce tenant predicates and narrowly granted functions; service-role calls bypass ordinary RLS protection. No service-role key, database password or privileged credential enters dashboard/extension bundles. [Supabase RLS guidance](https://supabase.com/docs/guides/database/postgres/row-level-security) documents this boundary. Enforce parameterized queries, cross-tenant negative tests, limited extension host permissions and credential revocation. No LinkedIn passwords or cookies are uploaded or stored by the product.

## Operation surface

Each mutation takes an idempotency key and expected resource revision where applicable; same key with different content conflicts. Responses expose stable IDs, new revisions and typed rejection/hold reasons. Pagination has a server maximum of 100 records. Error families distinguish authentication/access denial, revision conflict, capability/identity/observation hold, incompatible client and quota/admission refusal.

| Operation under `/v1` | Required behavior |
| --- | --- |
| `GET /me`, `GET/PATCH /accounts/{id}/settings` | Allowlist/product identity, account binding, caps/timezone/hours and revisions; settings changes cannot evade reservations |
| `POST /executors`, `POST /executors/{id}/revoke` | Register device with explicit account binding; revoke future authority and reconcile in-flight attempts; no account identity inferred from email |
| `POST /imports/preview`, `POST /imports/{id}/confirm` | Selected standard-search profiles only; validate adapter evidence, dedupe account-recipient, show missing fields, enforce 1,000 prospect bound transactionally |
| `GET/POST /lists`, `PATCH /lists/{id}/memberships`, `GET /prospects` | Tenant-safe paginated lists and memberships; no import means automatic enrollment |
| `POST /campaigns`, `GET/PATCH /campaigns/{id}/draft` | Versioned draft, optional note/first message/up to three follow-ups and gaps; do not invent personalization values |
| `POST /campaigns/{id}/approvals` | Batch approve recipients and exact rendered content/settings revisions; missing values or unsupported note allowance block affected action |
| `POST /campaigns/{id}/enrollments` | Transactional active-recipient uniqueness and baseline guards; return explicit per-recipient rejected/held/skipped results |
| `POST /accounts/{id}/pause`, `POST /campaigns/{id}/pause`, `POST /enrollments/{id}/pause` | Immediate authority barrier at requested level; reconcile already possible sends |
| `POST /accounts/{id}/resume`, `POST /campaigns/{id}/resume`, `POST /enrollments/{id}/resume` | Revalidate all guards; clearing one layer cannot bypass another |
| `POST /campaigns/{id}/stop`, `POST /enrollments/{id}/stop` | Terminal cancellation of remaining intent; preserve facts and uncertain attempt reconciliation |
| `GET /accounts/{id}/queue` | Visible due, waiting, paused, held, uncertain and cancelled reasons; no hidden retry queue |
| `POST /observations` | Bounded batch, deduplicate observation IDs, validate account/recipient/adapter evidence; unverified page reports cannot authorize sends |
| `POST /accounts/{id}/claims` | Atomic single-sender claim with account lock, durable action and limit reservations; only eligible current revision |
| `POST /attempts/{id}/authorize-send` | Final fresh preflight, expected fencing token/revisions; atomically record cloud may-have-sent before issuing one-use authorization |
| `POST /attempts/{id}/outcomes` | Idempotent append of NOT_SENT, CONFIRMED_SENT or OUTCOME_UNKNOWN evidence; accept authenticated late results for audit/reconciliation, never stale authority |
| `POST /attempts/{id}/reconcile` | Submit new adapter evidence; server decides disposition. User cannot turn “probably not sent” into retry permission |
| `POST /exports`, `GET /exports/{id}`, `POST /deletions` | Authenticated asynchronous export/delete with reauthentication for deletion; tenant-only short-lived download; stop authority before erasure |

Operational admin access is separate, audited and least privilege. Revoked executors cannot claim or authorize; a narrowly scoped result-only channel may ingest signed late evidence for their existing attempts after current owner authentication. Lost access cannot make uncertain work eligible again. Deletion may accept only minimal attempt fencing facts during reconciliation; private content does not reappear.

## Meaningful contract types

| Type | Required meaning |
| --- | --- |
| `Observation` | Contract version, observation ID, workspace/account/recipient, executor + adapter versions, observed/received time, source page type, verified identity evidence, facts (connection/message direction/event time/fingerprint), coverage boundary/cursor, completeness flag, uncertainty reason and evidence provenance; no incoming message body |
| `ActionCommand` | Contract version, logical action/enrollment/attempt IDs, exact approved rendered payload and content/approval/settings/enrollment revisions, recipient/account identity, action type, lease/fencing token, expiry and required evidence set; never interpreted as authority without authorize-send |
| `AttemptResult` | Contract version, attempt/action/lease/executor IDs, stable result ID, one outcome enum, event/receipt time, evidence and uncertainty reason; “clicked” alone is not CONFIRMED_SENT |
| `ExecutionLease` | Lease ID, account/action/attempt/executor binding, monotonically increasing fencing token, issued/expiry time and phase; one account sender, one attempt; not a transferable lock |

Raw page observations remain unverified until validated against the adapter's versioned evidence rules. “Complete” must name coverage since enrollment/baseline and relevant conversation identity; a loaded visible fragment is not a complete conversation. No reply requires positive coverage of the relevant interval, not an empty DOM match. Missing timestamps, partial lists, uncertain attribution or incompatible evidence versions hold the sequence. The feasibility story must define fixtures that justify each claim; this baseline asserts no selector or coverage reliability.

Initial engineering defaults: lease 60 seconds; authorize-send window 10 seconds; account/recipient/conversation/allowance observations no older than 30 seconds at authorization. A fresh local check immediately before click must still match and occur inside that window. Adapter/server clock skew and evidence latency limits must be tested; excessive/unknown skew fails closed. Thirty seconds is a provisional upper bound, not proof that a reply cannot race the send. Unsupported contract major versions or revoked adapter versions fail closed; minor additions are accepted only when declared compatible.

## Transactional claim and final preflight

1. Browser syncs unresolved journal entries before asking for new work. Server refuses all sends for an account with an unresolved possible send, conflicting executor or unresolved identity.
2. A database transaction locks the account sender slot and selected action, checks tenant, account binding, enabled capability, current approvals, enrollment reservation, pause/stop layers, due time/hours, fresh evidence, quota headroom and account-wide limits. It creates one attempt/lease and reserves budget. Concurrent claims cannot both win; unique constraints enforce active enrollment and unresolved sender ownership.
3. Executor verifies signed-in account, recipient and current conversation/connection/note allowance. It writes a durable local prepared journal entry before authorize-send. Failed journal write blocks sending.
4. `authorize-send` repeats all eligibility and revision checks under the account lock. It durably records **may-have-sent in the cloud** before returning a short-lived single-use token. Conservative reservation begins even if the response is lost. Local journal then durably records **may-have-sent before clicking**. No confirmed cloud response or local journal persistence means no click.
5. Executor makes a final local account/recipient/conversation and expiry check, then may click once. A failed final check reports NOT_SENT only with positive no-send evidence; otherwise uncertainty remains. New pause/stop or edit transactions fence unused authority, but cannot undo a click already possible.
6. Persist result locally first, then submit outcome. CONFIRMED_SENT requires adapter positive evidence tied to this attempt and recipient. NOT_SENT means demonstrably no remote send; timeout, disappearance, tab close, expired token or lost response never proves it. OUTCOME_UNKNOWN blocks retry and next steps and retains the account sender barrier.

An expired lease before authorization may be reclaimed after transactionally proving no may-have-sent record exists. An expired/lost authorization after a possible send is never reassigned or redispatched. The local executor also never reuses an authorization after restart. Reservations for unresolved possible sends remain conservatively consumed; known no-send releases them once, confirmed send converts them once. Midnight does not clear uncertainty. A single-use token and database idempotency prevent duplicate local commands, not exactly-once delivery on LinkedIn.

## Late outcomes, recovery and bounded races

Reconcile stable attempt IDs after worker restart, network outage or lease expiry. Duplicate equivalent results are harmless; contradictory results are preserved as facts and held for review. Late confirmed evidence can change an unknown attempt to confirmed even after stop/deletion intent; it must not revive enrollment or schedule a follow-up after a reply, takeover, stop or approval change. Stale fencing tokens cannot authorize new work. Authenticated results are evidence, not instructions to bypass current guards.

Network outage, account mismatch, ambiguous identity, stale evidence or incompatible client fails closed for new sends. Stop is immediate in local browser state if the API is unreachable and must sync; the dashboard displays that remote confirmation is pending. A disconnected executor gets no new authority, but one already authorized click may still occur within the short window. An external user can reply, withdraw or manually message between our last observation and click. This bounded race cannot be eliminated by our database transaction; the UI and gate evidence must state it honestly.

After database restore, start globally paused, revoke all executor authority, reconcile off-site backup cutoff with cloud/local attempt facts and fresh adapter evidence, and revalidate every active enrollment. Historical due rows are not replay instructions. Missing journals or evidence leave possible sends held indefinitely until positive reconciliation; there is no “retry after timeout” escape hatch. [Operations](nfr-operations.md) defines backup custody and deletion handling.
