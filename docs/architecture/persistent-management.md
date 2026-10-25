# Persistent prospect and campaign management

## Scope and decisions

Status: implemented, 20 October 2026. The hosted owner-only workspace saves synthetic prospects, lists, campaign drafts, rendered approvals and recipient progress. Sending remains disabled by the existing database constraint and by the absence of dispatch endpoints. No browser adapter or real import is added.

The first import source is a fixed, versioned fictional sample catalog. A user selects rows, previews them and confirms a list name. This removes uncertain identity and personal-data collection from the persistence implementation. Missing optional fields remain missing. Blank required values, duplicate input keys, unknown catalog keys and batches over 100 are rejected. One synthetic account is created lazily; it is explicitly not a verified LinkedIn binding. Imports deduplicate by account and recipient key and enforce 1,000 saved prospects atomically.

## Interfaces and concurrency

Authenticated same-origin routes share the existing session, admission, rate limits and CSRF checks. The backend calls narrowly scoped PostgreSQL RPC functions through Supabase REST using the verified user's token. No service credential or provider token reaches dashboard JavaScript. Database functions independently check live workspace ownership. Workspace and account are derived, never trusted from request identifiers.

Read operations return prospects and progress in pages of 50. The management API caps campaign and list creation at 100 per workspace and returns their bounded summaries. Write operations carry a UUID request ID; the database stores the normalized request and result. Retrying the same request returns the recorded result; reusing its ID with different content conflicts. Workspace-row locking serializes mutations and limit checks. Campaign writes also require the current revision. Idempotency records follow user data retention; they are not technical logs.

Draft content contains an optional invitation note, required first message and up to three follow-ups with positive delays in days. Supported substitutions are {{name}}, {{company}} and {{role}}. Unknown placeholders or missing substituted fields reject approval. Draft recipient selection is explicit and bounded to 100. A preview renders every selected recipient; approval must match this exact preview and revision. Saving changes invalidates unsent approvals and holds existing nonterminal enrollments. Removed recipients stop. No terminal recipient automatically restarts.

## State mapping and critique resolutions

Persistent enrollment states use the existing campaign-engine vocabulary. Existing connected people are excluded. Pending invitations wait without another invitation. Unknown state holds. Confirmed rejection or withdrawal stops. Other synthetic recipients remain held because execution capability is disabled. Completed records are displayed as completed, never fabricated by the management API. Conversation transitions and send outcomes remain the tested simulator's responsibility until an observation/execution adapter is assigned.

Paused and held enrollments continue to reserve the account/recipient slot. Approval rejects another campaign's active enrollment. Pause/stop invalidates execution ownership and cancels unexecuted actions, while preserving uncertain or confirmed send history. Resume returns to held for fresh approval/reconciliation; it never creates a sending opportunity. Failed writes remain visibly unconfirmed, with an idempotent retry using the original request ID. A stale revision requires reload and review.

Self-critique identified direct REST writes, stale previews, concurrent enrollment and ambiguous network failures as bypass risks. Database validation, transactional locks, exact preview comparison and stored mutation results address these. Existing identity is never upgraded from synthetic to verified. Existing applied migrations remain unchanged. Forward fixes from integration address a SQL alias collision and use SHA-256 for preview fingerprints. Profile or campaign edits through direct REST also invalidate approval and fence intent. An action keeps its original content revision when its enrollment is reapproved; a database trigger still enforces matching campaign identity.

## Planned verification

Add contract and authenticated API tests, UI tests for preview/approval and unconfirmed mutation retry, and guarded hosted SQL tests for ownership, limits, replay, revision conflict, approval invalidation, duplicate enrollment and pause/stop. Run application regression, typecheck, formatting, build and documentation checks. Test migrations on sequence-test before sequence-dev. Record deployment/browser evidence separately from mocked tests; do not claim load, real LinkedIn or independent security review.
