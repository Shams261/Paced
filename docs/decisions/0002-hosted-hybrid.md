# ADR-0002: Hosted hybrid deployment and free stack

Decision status: Accepted

## Context

The user approved a hosted invite-only pilot with local development, central campaign data and browser-only LinkedIn execution, replacing the earlier local-only product direction.

## Decision

Use React/TypeScript/Vite on Cloudflare Pages, Chrome MV3 with a separate adapter, Hono/TypeScript on Workers and Supabase PostgreSQL + Auth. Google sign-in and an administrator-managed allowlist protect product access; initial database region is Canada (Central), `ca-central-1`. Use SQL migrations and a PostgreSQL durable queue, with no Redis. API and scheduled handler share modules. Development database is distinct from pilot data. See [overview](../architecture/overview.md).

Basis: the approved hosted MVP architecture baseline, 30 September 2026. Accepted means selected design, not tested implementation.

## Region amendment — 16 October 2026

The owner explicitly selected Canada instead of Frankfurt during project creation. The sequence-dev dashboard was observed Healthy in Canada (Central), ca-central-1. This supersedes the original region default only; latency targets remain unverified. Hosted development also replaces the proposed laptop Docker database.

## Alternatives and consequences

A local-only product avoids hosted costs but conflicts with the approved dashboard/data direction. Cloud browser execution removes the online-browser dependency but is excluded. A dedicated server/Redis adds operating cost without demonstrated need. The selected stack has quotas, global latency uncertainty, vendor-specific Auth/runtime migration work and unpacked extension distribution friction.

## Validation

Planned verification: Read-only adapter feasibility, hosted cross-tenant/security/load tests and regional latency measurement before admission; no integration or capacity inferred from provider limits.

At acceptance this was a documentation decision; no application, infrastructure, browser integration or live LinkedIn validation ran for it. Provider limits are dated research cited in the architecture documents.
