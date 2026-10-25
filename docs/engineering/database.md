# Hosted database development

## Targets and commands

The project uses two owner-controlled Supabase Free projects in Canada (Central): `sequence-dev` (`syisdkvnkbmbsbvchdgb`) and disposable synthetic-only `sequence-test` (`cimyhlakeloysxaquoqg`). PostgreSQL runs in the cloud; no laptop database, Docker or paid add-on is required. Short-lived Python/psql clients execute from this checkout.

Use Python 3.10+ and psql with support for `sslmode=verify-full`. The runner uses the dashboard-verified session pooler on port 5432, an exact project-scoped username, and the official Supabase CA stored in ignored `.local/supabase-ca.crt`. Passwords stay in ignored owner-only `.local/db-test-password.txt` and `.local/db-development-password.txt`; never commit or print them. These are plaintext local inputs, not a password vault. Production uses a separate secret-store decision. No arbitrary URL or environment PG override is accepted by the runner.

```bash
python3 scripts/database.py check --target test
python3 scripts/database.py migrate --target test
python3 scripts/test_database.py --confirm-test-project cimyhlakeloysxaquoqg
python3 -m unittest discover -s tests -v
# Only after test verification and review:
python3 scripts/database.py migrate --target development
# Operator quota meters and post-deletion identity removal:
python3 scripts/pilot_meters.py show --target development
python3 scripts/pilot_access.py delete-identity --target development --user <uuid> --confirm-project <ref> --confirm-email <email>
```

Tests require the application schema already migrated, and are intentionally separate from `npm test`. Run one integration test process at a time. The suite briefly inserts two deterministic synthetic users and fixtures, verifies Auth/REST access with temporary generated credentials, and removes only those fixtures. Ordinary SQL cases roll back. Concurrency tests use two actual simultaneous connections. Never put real users in the isolated test project.

## Migration lifecycle

Ordered SQL files live under `supabase/migrations`. The custom runner serializes migrations using a transaction lock, records SHA-256 checksums in private `sequence_meta.migrations`, skips matching applied versions, rejects changed versions and rolls back failures. Add a forward migration instead of editing an applied file. This ledger belongs to this runner; the Supabase dashboard's CLI migration history may not display it. Do not mix this runner with `supabase db push` without an explicit history migration.

`sequence_meta.environment` pins project identity and purpose. Initial setup refuses unrecognized existing application objects. Integration rebuild requires the exact test reference, matching marker and zero workspaces, and uses `DROP ... RESTRICT` on known application objects only. It never resets provider-managed schemas or development. Unknown dependencies stop the rebuild transaction. Test fixture cleanup touches only fixed synthetic workspace/user IDs; account isolation and wrong-target guards are part of the tests.

## Access and storage boundaries

Public `seq_` tables hold workspaces, account bindings, prospects, lists, memberships and campaign drafts. Private tables hold immutable content revisions/approvals/observations/attempt facts, enrollment/action progress, leases and unresolved-send reservations. Composite keys include workspace/account/campaign/recipient where needed. Account and recipient identities cannot be edited through ordinary client grants. Draft name/profile edits increment revisions; approval, scheduling and lifecycle API behavior belongs to later stories.

RLS plus explicit grants restrict authenticated users to an active allowlisted workspace and matching live provider/application session. Application logout or admission revocation denies old JWTs through direct REST as well as the API. The private auth runtime role has only narrow function grants and cannot inspect tables or approve users. Anonymous access is denied. `sequence_worker` is NOLOGIN with no client/authenticator membership. Its policies require an authenticated workspace subject; it is not a product login or public execution credential. Lease/reservation functions have fixed search paths, restricted execution grants, actor checks and account-row locks. Service-role and admin credentials must never reach the dashboard.

A lease alone never authorizes a LinkedIn action. Sending is constrained off. Expiry does not release an unresolved possible-send reservation; only a recorded positive final outcome can resolve it. Complete executor validation, approval invalidation, cap scheduling and API transition logic remain later work. The pure campaign engine remains independent of SQL.

## Evidence and limits

Synthetic SQL and email/password Auth fixtures verify isolation, not Google OAuth or live LinkedIn. Database rebuild is not an off-site backup restore drill. No hosted dashboard/API deployment, operational uptime or 100-user capacity is claimed.
