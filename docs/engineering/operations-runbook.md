# Operations runbook

This runbook describes how the pilot is operated day to day and what to do when something goes wrong. The operator is the repository owner. There is no on-call rotation and no uptime commitment; the pilot runs on free plans and reports its own limits honestly.

## What runs automatically

| Job | When | What it does | How you hear about it |
| --- | --- | --- | --- |
| Backup (`.github/workflows/backup.yml`) | Daily at 03:23 UTC | Encrypted data-only dump and deletion ledger to R2, seven days kept, backup log row written | GitHub emails the owner when the workflow fails |
| Operator health check (same workflow) | Daily, after the backup | Reads the content-free health report and fails the job on any alert | Same email |
| Auth maintenance (Worker cron) | Hourly | Expires login transactions, sessions and rate-limit counters; deletes denial records older than 30 days and usage counters older than 90 days | Silent |

## Daily check

Run the health report from the operator machine, or read the latest workflow run:

```bash
python3 scripts/pilot_status.py --target development
```

The report lists meters, recovery state, queue counts, pending operator actions, alerts and warnings. The signed-in dashboard shows the same meters, recovery and queue counts under **Workspace status**.

## Alerts and responses

| Alert | Meaning | Response |
| --- | --- | --- |
| `no-backup-recorded` / `backup-older-than-24h` | The last good backup is missing or older than 24 hours | Open the failed workflow run. Common causes: a paused Supabase project, an expired R2 token, a changed backup role password. Re-run the workflow after fixing. Admission of new users and any future sending stay blocked until a backup succeeds. |
| `meter-*-deny` | A free-tier meter is at or above 70 percent | Imports, new campaigns and approvals are already blocked. Reduce stored history only with the user's agreement, or decide on a paid upgrade explicitly. Never delete history silently. |
| `meter-*-warn` (warning) | A meter is at or above 60 percent | Watch daily; plan the decision above before 70 percent. |
| `meter-egress_month_bytes-unverified` / `provider-reading-*-stale` / `provider-reading-*-missing` | No Supabase egress reading in the last seven days | Read the monthly egress on the Supabase usage page and record it: `python3 scripts/pilot_meters.py set --target development --meter egress_month_bytes --value <bytes> --note "<source>"`. The `refresh-soon` warning appears from day five. |
| `uncertain-send-outcome` | A send may have happened without a confirmed outcome | Do not retry anything. Investigate the account's history before any sender is enabled for it; only a positive outcome resolves the reservation. (No executor exists yet.) |
| `identity-removal-overdue` / `identity-removal-pending` (warning) | A user deleted their workspace; their sign-in identity must be removed within seven days | `python3 scripts/pilot_access.py inspect --target development --user <uuid>` then `delete-identity` with the exact project and email. |
| `denials-last-5m-high` | 20 or more denied requests in five minutes | Check Workers Logs for the route and status pattern. Rate limits already apply. If one route is flooded, consider a temporary origin block at Cloudflare. |
| `provider-unavailable-recently` (warning) | The Worker could not reach Supabase or Google in the last five minutes | Check the Supabase project status page and Google OAuth status. Users see an honest unavailable message and can retry. |
| `due-work-delayed-no-executor` (warning) | Due actions exist but nothing executes them | Expected until a browser executor exists; it becomes an alert once executors are registered. |

## Incident procedures

**Paused Supabase project.** Free projects pause after a week without activity. The hosted app stops working and backups fail. Open the project in the Supabase dashboard and choose **Resume project**; allow two minutes. The isolated test project pauses more often because it is used only during verification.

**Supabase outage.** The dashboard shows access as unavailable and offers retry; no data is lost. Wait for the provider; do not change credentials or redeploy.

**Suspected credential exposure.** Backup role password: run `python3 scripts/backup_role.py enable --target development`, which generates a new password, then update the `PACED_BACKUP_DB_PASSWORD` repository secret. R2 token: revoke it in Cloudflare, create a new bucket-scoped token, update the two R2 secrets and `.local/r2-credentials.json`. GPG passphrase: `gpg --passwd <key>`, re-export the private keys to the password manager. Worker secrets: rotate through `wrangler secret put` with a new key version.

**Lost GPG private key.** Backups encrypted to that key cannot be read. Restore the key from the password manager or offline copy; if both are gone, generate new keys, commit the new public keys, and accept that older backups are unreadable.

**Restore for real.** Follow the drill in the [database guide](database.md) but target the development project only after a deliberate decision: the restore starts with every sequence held and all sessions revoked, users must be re-admitted, and LinkedIn provider links are not restored.

**Quota exhausted at the provider.** Supabase places free projects in a grace period rather than billing. Stop, export and delete keep working as long as the provider serves requests; growth is already blocked by the meters.

## Logs and retention

Workers Logs are enabled with full sampling but without invocation logs, so no request URL, query string, header or body reaches the provider. The live `wrangler tail` stream is different: it shows request URLs, so never run it while someone signs in (the OAuth callback URL carries a one-time code). Each request emits one JSON line with the request ID, a bounded route name, method, status, duration, SQL call count and response bytes. The provider keeps these for three days on the Free plan. Denial audit records in the database keep a reason code and request ID for 30 days; usage counters for 90 days. Nothing retains names, emails, profile URLs, tokens or message text.

## Weekly

- Record the Supabase egress reading (see above).
- Confirm the latest backup workflow run is green.
- Review pending identity removals and tombstones.
