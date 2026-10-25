# Development database design

Status: implemented, 16 October 2026. The database is hosted; no laptop-hosted database service is used. This document refines the accepted [data model](data-lifecycle.md); it does not authorize cloud provisioning.

## Hosted environment scope

Use Supabase Free for the development database and Auth. No local Docker database, background database service, or 4 GB/2 CPU laptop allocation is required. Code editing and short-lived migration/test clients may still run locally; moving those jobs to hosted CI is a separate setup decision. LinkedIn execution remains in the user's browser under the accepted architecture, even when the dashboard and database are hosted.

The owner created `sequence-dev` in the previously verified Free organization. On 16 October its dashboard showed Healthy, Canada (Central), `ca-central-1`, project reference `syisdkvnkbmbsbvchdgb`. Canada is the owner-selected replacement for Frankfurt. Project provisioning and the schema migrations are verified. Keep all records synthetic until authentication and operational admission pass. Use a second dedicated `sequence-test` Free project for migration/rebuild tests if a free slot is available. Do not create extra accounts to bypass quotas. If only one slot is available, keep destructive migration/reset tests blocked until an isolated test target is agreed; do not reset development or production data to work around the limit.

Provider-managed compute replaces the proposed local resource budget. As checked on 16 October 2026, [Supabase Free](https://supabase.com/pricing) lists 500 MB database per project, 50,000 monthly active users, 5 GB egress, two active projects and pausing after one week of inactivity. Automatic backups and branching are not included. These limits do not establish capacity for the planned 100-user pilot or its retained history. Monitor usage and halt growth before quotas are exhausted; no silent data deletion, paid upgrade or paid add-on.

The full hosted target stays Cloudflare Pages for the dashboard and Cloudflare Workers for Hono, with Supabase database/Auth. Deployment configuration, owner accounts and protected development access must be prepared before publishing. The current local Node API launcher is not already a deployed Worker. Use provider subdomains initially; a purchased domain is unnecessary. [Pages pricing](https://developers.cloudflare.com/pages/functions/pricing/) and [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) define the applicable free quotas.

Use TLS for remote database connections. Store migration credentials only in ignored local files or a hosted runner secret store; never in browser bundles, documentation or messages. Select a connection mode compatible with migration transactions and concurrent test sessions. Hosted project setup needs account/project identity and secure credential setup.

## Schema and constraints

Use UUID primary keys, UTC timestamps, explicit revisions, `workspace_id NOT NULL` on tenant tables and unique `(workspace_id, id)` parent keys. Composite foreign keys must include account and campaign scope where applicable, not only workspace scope. Index referencing columns and common workspace/account filters.

| Group | Tables and relationships | Required integrity |
| --- | --- | --- |
| Ownership | workspaces, access_allowlist, linkedin_accounts | One private workspace per auth user; one current account binding per workspace; no user-editable owner/allowlist |
| Prospects | prospects, lists, list_memberships | Unique account and verified recipient identity; memberships cannot join another tenant/account; synthetic identifiers explicitly labelled |
| Intent | campaigns, content_revisions, approvals, approval_recipients | Immutable approved revision and exact rendered recipient content; revision belongs to the same campaign/account; no client-created approval authority |
| Progress | enrollments, logical_actions | Partial unique account/recipient reservation for Active, Waiting, Paused and Held; unique enrollment/step; enforce step kind and ordinal bounds |
| Evidence | observations, attempts, attempt_results | Separate observed and received timestamps; immutable facts; composite references cannot attach another account's evidence; no incoming message bodies |
| Recovery | account_execution_state, execution_leases, send_reservations | One account coordination row; fencing counter; unresolved possible-send reservation survives lease expiry, stop and restart |

Keep connection, enrollment and action states separate using the accepted engine vocabulary. A terminal enrollment releases its active enrollment slot but never releases an unresolved possible-send reservation. A new enrollment cannot bypass that reservation. Do not implement a sending endpoint in this story.

## Roles and data access

Enable RLS and explicit grants in the same migration. Anonymous callers receive no domain access. Authenticated users may read their workspace records; ordinary editable prospect/list/campaign fields use ownership policies with both USING and WITH CHECK. Ownership comes from `auth.uid()` joined to the private workspace and active allowlist; browser-supplied workspace IDs are not authority. Index ownership lookups and avoid recursive policies.

Clients cannot write account verification, approval facts, sequence progress, attempts, execution leases or reservations directly. Keep internal tables/functions in a non-exposed schema, revoke PUBLIC function execution, and grant only narrowly scoped roles. Any required definer function fixes its search path, checks actor/workspace and expected revision, and has negative tests. User roles cannot assume privileged roles. Service credentials remain server-side; superuser/BYPASSRLS success is never isolation evidence. See [Supabase RLS guidance](https://supabase.com/docs/guides/database/postgres/row-level-security).

Use migrations to create tables and constraints now. Runtime coordinator functions and actual executor authorization are later work; the integration suite verifies reservation integrity using restricted database fixtures without exposing send authority. Synthetic JWT claims in direct SQL tests exercise policies, not real Google login. Hosted development Auth/REST checks exercise token-to-role mapping; actual allowlisted Google login remains S3-004.

## Migrations and recovery

Keep ordered SQL migrations under `supabase/migrations`, synthetic seeds separately, and integration tests outside application unit tests. Never modify an applied migration to repair shared state: add a forward migration. Test transactional failure rollback and rerun from the last successful migration. Use an explicit allowlisted hosted test project reference and disposable-data guard before fixture cleanup or schema rebuild. Require a matching project marker and verify it contains only synthetic test data. Refuse every development/production/unrecognized target. A remote URL alone is not sufficient authorization. Do not use a blanket remote database reset; scope rebuilds to approved test application objects, preserving provider-managed schemas.

Test fresh migration, repeat migration application with no duplicate effects, fixture installation, forward repair and rebuilding the disposable test database. This does not establish the pilot backup/restore target; operator restore drills are covered by the [pilot operations design](pilot-operations.md).

## Verification design

1. Two synthetic users with same-looking data: own reads and permitted edits succeed; foreign SELECT yields no rows; INSERT/UPDATE/DELETE and forged composite references fail or affect zero rows as specified. Include anonymous, revoked allowlist, null identity and ownership-change attempts.
2. Table grants, sequence/function privileges and runtime-equivalent roles are checked directly; privileged setup is separated from test assertions. Test REST token isolation as well as SQL policies.
3. Two concurrent database sessions race to enroll the same account/recipient: exactly one active row commits. Paused, Waiting and Held also reserve the recipient. Another account's identical recipient may enroll independently.
4. Duplicate logical action and attempt numbers fail. Cross-account/campaign approval and evidence references fail. Immutable facts reject ordinary update/delete paths; controlled user deletion remains a later audited flow.
5. A possible-send reservation survives lease expiry and terminal enrollment; no new action reservation succeeds until explicit resolution. Test account coordination row locking/fencing with concurrent transactions, not sequential mocks.
6. Fresh setup, failed migration rollback, forward repair and guarded disposable reset pass. Confirm TLS, the exact hosted target and absence of laptop database services. Record actual versions, counts, commands, and limitations.

## Delivery result

The foundation is implemented in the first four migrations on both Canada projects. Its integration suite covers real concurrent transactions, hosted synthetic Auth/REST isolation and migration recovery. [The database guide](../engineering/database.md) owns commands, target restrictions and custom migration history details. Google login, real send authority and pilot operational readiness remain later gates.
