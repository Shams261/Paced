# ADR-0005: Free pilot, retention and recovery constraints

Decision status: Accepted

## Context

The approved pilot has up to 100 users and 1,000 saved prospects each, global audience and no paid upgrade without approval. Retained user data can grow beyond free quotas.

## Decision

Retain lists/history until user deletion; store selected fields and minimal observations, no inbox bodies. Measure capacity and reserve headroom; deny growth/new sends before exhaustion while prioritizing stop/results/export/delete. Best-effort availability only. Operator maintains encrypted off-site backups with <=24h age and <=4h restore targets, deletion ledger and paused reconciliation after restore. See [NFR/operations](../architecture/nfr-operations.md).

Basis: the approved hosted MVP architecture baseline, 30 September 2026. Accepted means selected design, not tested implementation.

## Alternatives and consequences

Automatic paid scaling violates budget approval; silent history expiry violates retention; relying on free provider backups assumes a feature not included. Smaller admission, operational backup work and possible prolonged holds are accepted consequences. 100-user capacity and global latency remain unproved.

## Validation

Planned verification: Quota/load/egress measurements, long-history storage growth, authenticated export/delete and backup-custody/restore/deletion drills before admission and sends.

At acceptance this was a documentation decision; no application, infrastructure, browser integration or live LinkedIn validation ran for it. Provider limits are dated research cited in the architecture documents.
