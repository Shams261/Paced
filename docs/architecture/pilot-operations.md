# Pilot data lifecycle and operational gates

Status: export, workspace deletion, quota meters, the encrypted backup pipeline with its restore drill, content-free monitoring with an operator health check and runbook, and automated accessibility checks are implemented. Capacity measurement and the closure gate remain. Last updated 3 November 2026.

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
| C. Backup, ledger, restore | Daily encrypted PostgreSQL dump to R2 from a scheduled CI job, separate encrypted deletion ledger, timed isolated restore that applies tombstones and starts held | Private repository, R2 bucket, GPG keys | Backup log rows, checksum verification, restore timing, deleted fixture absent after restore | Implemented |
| D. Quotas and meters | Database, request and egress meters; warn at 60 percent, deny growth at 70 percent; stop, export and delete always allowed | None | Synthetic fault tests, API tests for blocked growth, UI shows the reason | Implemented |
| E. Monitoring and runbook | Content-free Workers Logs, operator health check in CI and on the operator machine, queue health in the dashboard, incident runbook | D | Health output, telemetry tests that reject content, runbook | Implemented |
| F. Capacity and latency | Separate test deployment, synthetic dataset, 30-minute steady workload from North America and India | Test deployment, regional clients | p50/p95/p99, errors, CPU, storage and egress against NFR targets | Planned |
| G. Accessibility | Keyboard and automated accessibility checks on core flows, plus a screen-reader pass | None | Playwright and axe results, manual checklist | Implemented; owner screen-reader pass done |
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

Migration 0012 creates `sequence_backup`, a SELECT-only role with a permissive read policy on every backed-up table and no grant on sessions, login transactions or rate-limit counters. The operator enables its login once per project; the password is stored only in an ignored local file and in the CI secret. The role cannot write, cannot run operator functions and has no dangerous attributes (tested).

A scheduled GitHub Actions workflow runs `scripts/backup.py` daily at 03:23 UTC (not on the hour, to avoid scheduler delays). Each run does the following:
1. Preflight: confirms the project marker, that the connected user is `sequence_backup`, and reads the latest migration version. Row counts of the main tables are captured.
2. `pg_dump -Fc --data-only --enable-row-security` of `public.seq_*` and `sequence_private.*`, excluding `deletion_tombstones`, `auth_sessions`, `login_transactions` and `auth_rate_limits`.
3. Minimal identity rows through `sequence_private.backup_identities()`: user ID, email, confirmation flag, admission flag and creation time. No password hashes, tokens or provider data.
4. All deletion tombstones as newline-delimited JSON for the ledger.
5. `metadata.json` with format version, generation time, project, migration version, dump checksum and size, excluded tables and counts.
6. A tar of metadata, identities and dump, encrypted with GPG to the backup public key; the ledger encrypted separately to the ledger public key. Public keys are committed in `supabase/backup-keys/` and their fingerprints are pinned in the script.
7. Upload to R2 under `backups/<stamp>.tar.gpg` and `ledger/<stamp>.jsonl.gpg`, plus a plaintext `backups/latest.json` pointer with key, checksum, size and versions. Objects older than seven days under `backups/` are deleted; ledger objects are kept.
8. `sequence_private.backup_record` writes the backup log row with the object key, checksum, size, migration version, counts and duration.

The R2 client is a small Signature Version 4 implementation on the standard library, verified against the published AWS example signature. A failed run notifies the owner through GitHub. Deletion now records the latest backup time as `backup_cutoff` on the tombstone, so the ledger names which backups still hold the data.

`scripts/restore_drill.py` is operator-only and targets the isolated test project exclusively. It downloads the latest backup, verifies the checksum, decrypts it with the operator's private key (the passphrase is entered in the terminal, never in the script), extracts and verifies the inner dump checksum, downloads and decrypts the newest ledger, rebuilds the empty test schema, replays migrations, inserts synthetic Auth rows for the identities so ownership foreign keys hold, restores tables in parent-to-child order with user triggers disabled for the copy (the operator is not a superuser, so internal foreign-key triggers stay on), applies the ledger with `sequence_private.apply_deletion_ledger`, calls `sequence_private.restore_finalize` (every nonterminal sequence held with reason `restore-reconciliation`, unexecuted actions cancelled, fences bumped, sessions revoked), validates counts, row-level security and the absence of deleted workspaces, records a `restore-drill` backup log row with step timings and the elapsed time against the four-hour target, and returns the test project to its empty migrated state.

Known limits: a restore into a fresh Supabase project recreates workspace ownership by user ID but not Google provider links, so users would be re-admitted by the operator after a real recovery; a dump older than the current schema restores only if no restored column was dropped since.

### Monitoring and runbook

Workers Logs are enabled with full head sampling and **invocation logs disabled**, so the provider never receives request URLs, query strings, headers or bodies. The Worker emits one JSON line per request through `apps/api/src/telemetry.ts`: request ID, a route name from a fixed list (anything else is `other`), method, status, duration, SQL call count and response bytes. The logger refuses events with unknown fields, wrong types or free text, and a telemetry failure never affects a response. Provider retention is three days on the Free plan.

Migration 0013 adds two read-only reports. `sequence_private.workspace_health(w)` returns a tenant's due, waiting and held counts, uncertain sends and unknown outcomes; the `status` management operation includes it and the dashboard shows it as a queue line. `sequence_private.operator_health()` returns the pilot-wide picture (meters, recovery, request counts, denials and provider failures in the last five minutes, uncertain outcomes, oldest due action, held sequences, pending identity removals with their seven-day due dates, provider reading ages) with no names, emails or text, and is executable by the backup role so that CI can read it without operator credentials.

`scripts/pilot_status.py` reads that report as the backup role and applies the NFR thresholds: alerts for a missing or stale backup, a meter at deny or unverified, a provider reading older than seven days or missing, any uncertain send outcome, an identity removal past its seven-day deadline and 20 or more denials in five minutes; warnings for meters at 60 percent, readings older than five days, recent provider failures, pending identity removals and due work with no executor. The backup workflow runs it daily after the backup with `--strict`, so any alert fails the job and GitHub emails the owner. The [operations runbook](../engineering/operations-runbook.md) describes the daily and weekly checks and the response to each alert and incident.

### Accessibility

`npm run test:a11y` runs Playwright with axe-core against the built hosted dashboard. Every request, including the static assets, is served from the build output through in-page routing, so the suite opens no listener. The checks cover the sign-in page, the admitted workspace, import preview and confirmation, draft editing, exact review and approval, pause and stop, progress states, export, the deletion flow with a stale sign-in, and the service-outage state. Each state is analyzed against the WCAG 2.0, 2.1 and 2.2 A and AA rule tags; serious or critical violations fail the test and lower-impact ones are printed. Every action is performed through the keyboard, and focused controls must show a visible outline or focus ring. One finding was fixed during the first run: the campaign selector's label wrapped the control, so its accessible name included every option; it now uses an explicit label association. The owner completed a manual VoiceOver pass of the same flows and reported no defects.

### Capacity and latency

Measured risk, 3 November 2026: a six-request `wrangler tail` sample after the slice E release showed 7 to 14 ms of CPU per invocation, including 10 to 12 ms for the session route that makes no database call. The NFR target is a p95 of 5 ms and the Free plan limit is 10 ms. The likely cause is that the Worker rebuilds the Hono application, database client, JWKS fetcher and token vault on every request. Slice F starts by caching the stateless parts per isolate and measuring again before any load test.

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
| Deletion tombstones | Until every backup that contains the workspace has expired; `backup_cutoff` records the last backup before deletion |

No log category retains names, profile URLs, message text, tokens or callback queries.

## Alternatives considered

| Concern | Alternative | Choice |
| --- | --- | --- |
| Export artifacts need encrypted storage and expiry | Temporary files in object storage | Stream directly; no second copy of user data |
| Deleting Auth users from the Worker widens its privilege | Service-role key in the Worker | Operator-only function with a seven-day target |
| In-database tombstones would be inside the backup | A separate project for the ledger | Exclude the table from dumps; the off-site ledger is authoritative during restore |
| Laptop-scheduled backups can be missed | launchd on the operator machine | Scheduled CI with a SELECT-only role and a bucket-scoped token |
| `pg_restore --disable-triggers` needs a superuser, which the operator is not | Grant superuser or bypass RLS | Restore parents before children and disable only user triggers during the copy |
| `pg_dump` refuses tables whose rows RLS would filter | A BYPASSRLS backup role (superuser-only to create) | `--enable-row-security` with an explicit read-all policy for the backup role |
| Load testing against development pollutes data and quota | Bounded load on the real app | A separate test deployment |
| Workers Logs could leak identifiers | Keep observability disabled | Enable with a content-free helper and a test |
| The full dataset may not fit 500 MB | A smaller dataset and a quietly lower target | Measure and lower the admission limit explicitly |
