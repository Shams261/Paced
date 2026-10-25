# Pilot data lifecycle and operational gates

Status: export, workspace deletion and quota meters are implemented. Backups, monitoring, capacity measurement and accessibility review are designed but not yet built. Last updated 20 October 2026.

## Problem and boundaries

Before any additional real user is admitted, the hosted pilot needs the following:
- authenticated export and deletion
- encrypted off-site backups with a separate deletion ledger and a timed restore drill
- quota and growth guards that block on stale meters
- measured regional workload
- a keyboard and accessibility review
- a named operator with monitoring and an incident runbook

The targets come from the [NFR specification](nfr-operations.md) and [ADR-0005](../decisions/0005-free-pilot-operations.md).

Out of scope:
- live LinkedIn capability
- admission of additional users
- paid upgrades and public launch

Deleting product records does not withdraw LinkedIn invitations or remove LinkedIn messages, and the UI says so.

### Provider limits

Checked against provider documentation on 20 October 2026:

- **Supabase backups.** Automated backups are only included on the Pro, Team and Enterprise plans. Free projects should export with a regular dump and keep copies off-site, because Free backups cannot be downloaded.
- **Supabase Free.** 500 MB database and 5 GB egress shared across all services; dumps through the pooler count toward egress. Two active projects, paused after one week of inactivity.
- **Cloudflare R2 free tier.** 10 GB-month of storage, 1 million Class A and 10 million Class B operations per month, and free egress. Creating a bucket requires adding an R2 subscription to the account.
- **Workers Free.** 100,000 requests per day, 10 ms of CPU per invocation and five Cron Triggers per account.
- **Workers Logs Free.** 200,000 events per day with three-day retention.
- **GitHub Free.** 2,000 Actions minutes per month for private repositories. Scheduled workflows can be delayed when GitHub is busy.
- **R2 API tokens.** Can be limited to Object Read & Write on specific buckets.

Both Supabase projects run PostgreSQL 17, so backup and restore tooling needs PostgreSQL 17 client tools.

## Work areas

| Area | Outcome | Depends on | Acceptance evidence | State |
| --- | --- | --- | --- | --- |
| A. Export | Authenticated, tenant-scoped export streamed as newline-delimited JSON; no stored artifact | None | API and contract tests, database ownership tests, owner download of the synthetic workspace, [format document](../engineering/export-format.md) | Implemented |
| B. Deletion | Reauthenticated deletion that fences execution, revokes sessions, removes product data and writes a tombstone; Auth identity removed by the operator within seven days | None | Database transaction and resurrection tests, hosted smoke on a disposable test workspace | Implemented |
| C. Backup, ledger, restore | Daily encrypted PostgreSQL dump to R2 from a scheduled CI job, separate encrypted deletion ledger, timed isolated restore that applies tombstones and starts paused | Private repository, R2 bucket, GPG keys | Backup log rows, checksum verification, restore timing, deleted fixture absent after restore | Planned |
| D. Quotas and meters | Database, request and egress meters; warn at 60 percent, deny growth at 70 percent; stop, export and delete always allowed | None | Synthetic fault tests, API tests for blocked growth, UI shows the reason | Implemented |
| E. Monitoring and runbook | Content-free Workers Logs, operator status command, incident runbook with a named operator | D | Status output, log inspection showing no identifiers or message text, reviewed runbook | Planned |
| F. Capacity and latency | Separate test deployment, synthetic dataset, 30-minute steady workload from North America and India | Test deployment, regional clients | p50/p95/p99, errors, CPU, storage and egress against NFR targets | Planned |
| G. Accessibility | Keyboard and automated accessibility checks on core flows, plus a screen-reader pass | None | Playwright and axe results, manual checklist | Planned |
| H. Closure | Hosted foundation closed against actual evidence; a failed gate lowers the admission limit explicitly instead of waiving the requirement | A–G | Updated project records | Planned |

## Implemented design

### Export

`POST /api/v1/export` requires the session cookie, active admission and the CSRF token. A POST is used instead of a GET so that a cross-site navigation cannot trigger a bulk read.

The Worker first fetches a manifest from `public.seq_export('manifest', 0)` with the signed-in user's token. The manifest holds the format version, workspace ID, generation time, page size and per-section counts. The Worker then requests each section in pages of 500 rows and pipes every page body through to the client **without parsing it**, so the cost in Worker CPU stays far below the 10 ms limit.

The response has three parts:
1. a `manifest` line
2. one line per section page
3. a final `end` line

The dashboard keeps the download only when the `end` line is present. The export never contains sessions, tokens, audit rows, idempotency records or other tenants' data. See the [export format](../engineering/export-format.md).

### Deletion

`POST /api/v1/delete-workspace` requires all of the following:
- CSRF
- the exact phrase `DELETE MY WORKSPACE`
- a sign-in no older than five minutes

Sign-in age is checked twice. The Worker uses the application session's creation time. The database uses `auth.sessions.created_at` for the provider session in the user's token. JWT `iat` is not used, because it changes on every token refresh.

`public.seq_delete_workspace` runs in one transaction:
1. Lock the workspace.
2. Deactivate admission. An existing trigger revokes every application session at this step.
3. Delete every tenant row in dependency order.
4. Write a tombstone with the opaque workspace ID, user ID, request ID, removal counts and any unresolved possible-send count.

A retry with the same request ID returns the recorded result. Late results cannot recreate data, because every tenant row references the deleted workspace and an insert fails on the foreign key. The route then revokes the current session, clears the cookie and attempts provider sign-out.

The Supabase Auth identity is removed afterwards by the operator with `scripts/pilot_access.py delete-identity`. That command calls `sequence_private.operator_remove_identity`. The function refuses unless a tombstone exists and no workspace remains. The Worker's runtime role cannot execute it. This keeps provider-schema deletion behind the guarded operator credential.

### Quotas and meters

The Worker counts each response's bytes with a `TransformStream`. After the body finishes, it records one request and those bytes in `sequence_private.usage_counters` for the current UTC day. This happens outside the request path, and a failure never affects the response.

The operator can enter provider dashboard readings in `sequence_private.provider_readings` with `scripts/pilot_meters.py`.

`sequence_private.quota_status()` computes three meters at check time:

| Meter | Limit | Self-measured source |
| --- | --- | --- |
| `database_bytes` | 500 MB | `pg_database_size` |
| `requests_day` | 100,000 | Worker request counter for today |
| `egress_month_bytes` | 5 GB | Worker response bytes this month (partial) |

Each meter takes the greater of the self-measured value and any provider reading younger than seven days. A meter is `ok` below 60 percent, `warn` from 60 percent and `deny` from 70 percent.

Egress is `unverified` without a fresh provider reading. The Worker cannot see Supabase REST, Auth or backup traffic directly, so a provider reading is required.

`seq_manage` refuses three operations with SQLSTATE 53400 when any meter denies or egress is unverified:
- `import`
- `save-draft` for a new campaign
- `approve`

The API maps this to `GROWTH_BLOCKED`. Snapshot, preview, edits to existing drafts, pause, resume, stop, export and delete are never blocked. `GET /api/v1/status` and the dashboard show the meters, the reasons and the recovery state.

The hard limits of 100 users and 1,000 prospects per account remain transactional regardless of meters. Usage counters are kept for 90 days.

### Critique and resolutions

| Concern | Resolution |
| --- | --- |
| Parsing a full export in the Worker could exceed the Free CPU limit | Stream page bodies unparsed; parse only the manifest |
| A GET download could be triggered cross-site with a Lax cookie | POST with a CSRF token |
| JWT `iat` reflects token refresh, not sign-in | Use provider and application session creation times |
| A retried delete after success would fail because the workspace is gone | Tombstones store the request ID and result |
| Late results could recreate deleted data | Foreign keys to the deleted workspace reject them (tested) |
| A human cannot refresh a provider reading every 15 minutes | Self-measured meters are computed at check time; provider readings stay valid for seven days |
| Recording usage needs the database after the response ends | The connection closes in the deferred usage task |

## Planned design

### Backup, ledger and restore

A scheduled CI workflow runs a backup script once a day with PostgreSQL 17 client tools. A forward migration will add a `sequence_backup` role with SELECT-only access to the application schemas and INSERT on a `backup_log` table. The CI workflow holds three kinds of secrets:
- that role's password
- a bucket-scoped R2 token with Object Read & Write only
- two GPG public keys

Each run does the following:
1. Takes a custom-format `pg_dump` of the application schemas, excluding the tombstone table, plus the Auth identity rows needed to relink admission.
2. Records the SHA-256 checksum, size and migration version.
3. Encrypts the dump with the backup key and uploads it under a dated `backups/` prefix.
4. Appends new tombstones to an encrypted object under `ledger/`, using a separate ledger key.
5. Writes a `backup_log` row.

Seven rolling days are kept. A failed run notifies the operator, and a backup older than 24 hours marks recovery as degraded and blocks growth.

The restore drill runs on the operator's machine with the private keys. It restores into the isolated test project behind the existing rebuild guard, replays newer migrations and applies the ledger before any access. It then validates grants, row-level security and checksums with the integration suite, starts globally paused, and records the elapsed time. The drill passes within four hours if the deleted fixture is absent.

Private keys are held in the operator's password manager, with one offline recovery copy.

### Monitoring and runbook

Workers Logs will be enabled with content-free events only: request ID, route, status, duration, SQL count and bounded reason codes. A test will reject forbidden fields.

An operator status command will report several values:
- error rate
- oldest due action
- uncertain outcomes
- meters
- backup age

The runbook covers daily checks, the NFR alert thresholds, and the response to a missed backup, a quota warning, an uncertain send or a provider outage.

### Capacity and latency

The production Worker is bound to the development project, so load testing uses a second private Worker and Pages project. These are bound to the isolated test project with their own Hyperdrive configuration and secrets.

A generator creates the dataset: 100 workspaces, 1,000 prospects each, ten campaigns per workspace and six months of history. If the dataset exceeds 70 percent of 500 MB, the result is recorded and the admission limit is lowered.

k6 runs for 30 minutes after warm-up from two places: a CI runner in North America and a machine in India. Each run reports p50/p95/p99, errors, cold starts, Worker CPU, storage and egress. Runs stay inside the shared daily request budget.

### Accessibility

Playwright with axe-core will test these flows against the built dashboard with a mocked API:
- sign-in
- import preview
- draft editing
- approval
- progress
- pause, resume and stop
- errors
- export and delete

The checks cover keyboard-only use, visible focus and the WCAG 2.2 AA rules. A manual VoiceOver pass completes the review.

## Logging and retention

The earlier NFR proposed 14-day technical logs. The implemented policy supersedes it:

| Record | Retention |
| --- | --- |
| Auth denial and dependency audit (reason code, request ID, no identity) | 30 days, cleaned hourly |
| Operator admission audit (actor, target, action) | Until the target user is deleted |
| Workers platform logs (content-free) | Three days, provider-managed |
| Aggregate usage counters | 90 days |
| Management idempotency records | With the workspace; removed on deletion |
| Deletion tombstones | Until every backup that contains the workspace has expired |

No log category retains names, profile URLs, message text, tokens or callback queries.

## Alternatives considered

| Concern | Alternative | Choice |
| --- | --- | --- |
| Export artifacts need encrypted storage and expiry | Temporary files in object storage | Stream directly; no second copy of user data |
| Deleting Auth users from the Worker widens its privilege | Service-role key in the Worker | Operator-only function with a seven-day target |
| In-database tombstones would be inside the backup | A separate project for the ledger | Exclude the table from dumps; the off-site ledger is authoritative during restore |
| Laptop-scheduled backups can be missed | launchd on the operator machine | Scheduled CI with a SELECT-only role and a bucket-scoped token |
| Load testing against development pollutes data and quota | Bounded load on the real app | A separate test deployment |
| Workers Logs could leak identifiers | Keep observability disabled | Enable with a content-free helper and a test |
| The full dataset may not fit 500 MB | A smaller dataset and a quietly lower target | Measure and lower the admission limit explicitly |
