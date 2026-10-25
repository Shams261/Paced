# Hosted deployment and module ownership

Baseline: user-approved design, 30 September 2026. [ADR-0002](../decisions/0002-hosted-hybrid.md) selects the stack; [ADR-0003](../decisions/0003-state-ownership.md), [ADR-0004](../decisions/0004-send-reconciliation.md) and [ADR-0005](../decisions/0005-free-pilot-operations.md) define state, execution and operating constraints.

## Product and development deployment

```mermaid
flowchart LR
  subgraph Product[Hosted pilot]
    UI[React TypeScript Vite dashboard on Cloudflare Pages]
    API[Hono TypeScript backend on Workers]
    Schedule[Workers scheduled handler]
    DB[Supabase PostgreSQL and Auth in Canada (Central)]
    UI --> API
    UI --> DB
    API --> DB
    Schedule --> DB
  end
  subgraph UserBrowser[User signed-in browser]
    Ext[Chrome MV3 extension and separate adapter]
    Journal[IndexedDB unsynced attempt journal]
    LI[LinkedIn pages]
    Ext --> Journal
    Ext --> LI
  end
  Ext --> API
  subgraph Development[Local development]
    Code[Source and future test tools]
    DevDB[Separate development PostgreSQL database]
    Code --> DevDB
  end
```

The UI-to-Supabase path is product authentication only; campaign writes and reads use the authenticated API. The backend API and scheduled handler share the same application/domain modules and database. They are entry points in one modular backend, not independent microservices. A scheduler can make actions due; only the user's extension can interact with LinkedIn. Offline browsers wait. Cloud workers never host a LinkedIn browser.

Development and tests run locally. The development database uses separate credentials, migrations and synthetic data, never the hosted pilot database as a convenient test database. Hosted Supabase projects are used for development and isolated testing; see the [development database design](development-database.md).

## Ownership and dependency direction

| Module | Owns | Dependencies and boundaries |
| --- | --- | --- |
| Identity and access | Product user, pilot allowlist, workspace ownership, executor registration/revocation | Supabase Auth verification, tenant repository interface; product login is separate from LinkedIn |
| Prospects and lists | Selected profile fields, deduplication, memberships, import previews | Identity, storage interfaces, adapter observations; no full inbox archive |
| Campaign and approval | Drafts, rendered recipient content, content revisions, approval snapshots | Prospects, identity, pure engine validation; edits invalidate affected unsent approvals |
| Pure engine | Deterministic eligibility and state transitions | Typed domain values and injected clock only; no selectors, storage, cloud SDKs or browser calls |
| Scheduling | Due work, account working hours/caps, reservations, PostgreSQL durable queue | Engine, transactional repositories; does not click or infer send success |
| Execution and recovery | Lease, authorization, outcomes, reconciliation and journal sync | Engine, queue, adapter evidence; uncertainty holds work |
| LinkedIn adapter | Account/profile recognition, bounded observations, eventual controlled interaction | Browser page interface and versioned contracts; selectors never enter the engine |
| Dashboard | Review, queue, pause/stop, visible uncertainty and account settings | API and product Auth; no direct privileged database access |

Cloud data is the source of campaign intent and recorded history. Observations are dated evidence about LinkedIn reality, not guaranteed real-time truth. IndexedDB stores unsynced attempts and survives extension worker restarts; it is not the primary campaign store. Loss of the journal does not make an uncertain cloud attempt safe to repeat. Chrome may terminate workers ([lifecycle documentation](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)).

## Selected services and portability

Use React + TypeScript + Vite, Chrome Manifest V3, a TypeScript modular backend with Hono on Cloudflare Workers, Cloudflare Pages static hosting, and Supabase PostgreSQL + Auth. Google sign-in plus an administrator-managed allowlist gates pilot access at every API request. No self-service workspace sharing. Initial database region is Canada (Central) (`ca-central-1`), an [available region](https://supabase.com/docs/guides/platform/regions), not a demonstrated global latency result.

Versioned SQL migrations own schema evolution; PostgreSQL provides the durable action queue without Redis. Repositories hide storage APIs from the engine. Ordinary PostgreSQL data/SQL can move, but Auth identities, OAuth redirect URLs, Workers bindings/scheduling, RLS and extension endpoints still require migration and testing. Portability is a design boundary, not one-click multi-cloud failover. [Hono documents Workers deployment and testing](https://hono.dev/docs/getting-started/cloudflare-workers).

## Rollout and upgrade boundaries

Start with no send capability. Refine read-only feasibility, then simulator, hosted foundation and explicit controlled execution gates. Validate browser identity, observations and reconciliation before enabling a send type; keep unsupported capabilities disabled and visible. Pilot distribution is an unpacked extension to invited users; onboarding friction and update/version coordination remain operator work. [Web Store registration has a fee](https://developer.chrome.com/docs/webstore/register); publication is deferred.

Pilot bounds are 100 users, one LinkedIn account per user and 1,000 saved prospects per account. Free services are a budget constraint until revenue or a separately approved upgrade, not a capacity promise. Admission and sends stop before quota exhaustion; see [operations](nfr-operations.md). No paid upgrade, external account creation, publication or deployment is authorized by these documents. Future Vitest, PostgreSQL integration tests and Playwright are intended tools, not installed or executed checks.
