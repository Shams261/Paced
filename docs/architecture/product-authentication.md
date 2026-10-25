# Product authentication and pilot access

Status: implemented and deployed for the owner-only hosted development environment. This design replaces an earlier browser-token proposal. An independent security review is still required before additional real users are admitted.

## Hosting and identity

Use Cloudflare Pages for the dashboard and a Pages Function forwarding `/api/*` through a private service binding to the Hono Worker. Disable the Worker's separate public endpoint, including preview access. Use one exact public application origin. See [Pages bindings](https://developers.cloudflare.com/pages/functions/bindings/).

Google sign-in through Supabase confirms identity, not admission. Request only basic identity scopes. An unapproved user sees Access pending and logout without workspace access. Operator approval creates exactly one private workspace atomically and idempotently. Product login remains separate from LinkedIn; no LinkedIn credentials or executor registration are in scope.

Use authorization code with PKCE and supported Supabase client APIs. Exchange the code on the backend with a one-time browser-bound transaction expiring after ten minutes. Keep its verifier server-side. Reject reused/missing transactions and arbitrary return destinations. Callback processing must remove sensitive query parameters immediately, including failure paths, and never log callback query strings.

Google's authorized redirect is `https://syisdkvnkbmbsbvchdgb.supabase.co/auth/v1/callback`. Supabase's application return is `https://sequence-dev-etj.pages.dev/api/auth/callback`. Do not register wildcard preview origins or the random-port local preview. Use sequence-dev for real owner Google login and sequence-test for synthetic automated identities. The projects are in Canada Central. A third free project is not assumed.

The owner controls the Cloudflare account, the Pages origin, the Google project and client, and the initial approved Google identity. Credentials go into provider settings or secret storage, never into messages or tracked files. Google client secrets belong in Supabase provider settings. Public launch and paid upgrades are out of scope.

## Private application sessions

Issue a random opaque session identifier with at least 256 bits of entropy in `__Host-sequence_session`, with HttpOnly, Secure, SameSite=Lax, Path=/ and no Domain. Store only its hash in a private session record. Provider access/refresh tokens remain server-side, encrypted with authenticated encryption and a versioned Worker-secret key. Never return them to dashboard JavaScript or browser local storage.

Expire sessions after 30 minutes of inactivity or 24 hours absolute lifetime. Use database ownership and version checks to serialize refresh. Never hold a database transaction across a provider network request. Failed/crashed refresh with uncertain token rotation requires reauthentication rather than competing refresh attempts. Rotate the opaque identifier after login; a pre-login transaction must not become the authenticated session.

Require exact-origin validation and session-bound CSRF tokens for authenticated mutations. Login initiation uses exact-origin and browser-transaction checks; the OAuth callback uses its one-time binding instead of an Origin header assumption. Set restrictive CSP, no-store for auth/protected responses, and no sensitive URL logging. See [OWASP session guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).

## Database and revocation

Create a dedicated runtime database role without administrative privileges, RLS bypass or arbitrary table grants. Grant only narrowly scoped session-management functions. Use Hyperdrive with verified TLS and query caching disabled; credentials remain in provider secret/binding configuration. Do not use the existing postgres operator password or sequence_worker role as the public application runtime identity. Count Hyperdrive queries against the free allowance; no automatic paid upgrade. See [pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/).

Normal product data requests use the verified user's Supabase token and RLS. Validate signature, permitted algorithm, exact issuer, audience, expiry, subject and session identity. Derive workspace ownership server-side. Require active admission, a live Supabase session bound to that subject and an unexpired, non-revoked application session at both API and RLS boundaries. Do not positively cache these authorization decisions. Narrow security-definer helpers must have fixed search paths and restricted grants; auth/session tables remain private.

Logout revokes the application session first, then requests current-session Supabase sign-out. Old tokens must fail subsequent API and direct REST access, even if provider sign-out fails after local revocation. If local revocation cannot commit, clear browser state but report server revocation unconfirmed and offer retry. Administrator revocation invalidates all application sessions; later approval cannot resurrect them. Fail closed with retryable 503 when authorization state cannot be checked. Revocation applies to authorization after commit, not requests already authorized. See [Supabase sign-out](https://supabase.com/docs/guides/auth/signout).

## Interfaces and user experience

| Interface | Behavior |
| --- | --- |
| GET /api/auth/session | Signed-out, pending or admitted state; CSRF token where applicable; no provider tokens. |
| POST /api/auth/login | Same-origin initiation and browser-bound Google login transaction. |
| GET /api/auth/callback | Consume transaction, exchange code, create session and redirect to a clean URL. |
| POST /api/auth/logout | Validate CSRF, revoke current session and clear cookie. |
| GET /api/v1/me | Minimal verified identity and authorized workspace. |
| Operator approve/revoke command | Review verified Google subject and fixed target; atomically update admission and audit. |

Keep health public and fictional demo data clearly labelled. Prospect and campaign screens are described in the [management design](persistent-management.md). Provide keyboard-accessible login, cancellation, pending, expired, denied and dependency-unavailable states. Clear protected UI on logout. Use 401 for invalid sessions, 403 for denied access, 429 with Retry-After for limits and 503 for unavailable authorization dependencies.

Apply atomic limits of ten login starts per ten minutes per hashed IP, twenty callbacks per ten minutes per hashed IP and 120 protected requests per minute per session. Use trusted platform IP metadata rather than caller-controlled forwarded headers. Expire counters automatically. Rate limits are workload controls, not a guarantee against abuse.

Keep bounded technical reason codes and request IDs for 30 days, excluding credentials, callback queries, emails and message text. Record operator actor, target UUID, action and timestamp; ordinary users cannot change audit records. Operator audit retention follows user-deletion policy. Implement expiry/cleanup and bounds rather than relying on a documented promise alone.

## Design critique and resolutions

- JWT verification alone cannot enforce immediate revocation, so row-level security also checks application and Supabase session state.
- HttpOnly cookies require CSRF defenses. Every authenticated mutation carries a session-bound CSRF token.
- Server-side token storage requires authenticated encryption and least-privilege database access.
- Refresh races require database coordination. A single refresh owner is claimed before any provider call, and uncertain rotation forces reauthentication.
- IP rate limits must not trust spoofable headers. Only the private Pages proxy sets the client IP header, overwriting any caller value.
- Session-aware row-level security and uncached reads add database work, so free-tier capacity must be measured rather than assumed.

## Verification

The implementation is covered by these tests and checks:
- **Login states.** Valid Google login, cancellation, pending and admitted states. Repeated approval creates one workspace.
- **Token rejection.** Invalid, expired, tampered, wrong-project and wrong-subject tokens, and forged cross-user resource IDs.
- **Login flow attacks.** Callback replay, missing transaction, CSRF, malicious redirects and session fixation.
- **Revocation.** Logout, administrator revocation and expiry deny both the API and direct database REST requests. Reapproval does not revive old sessions.
- **Failure handling.** Concurrent refresh, browser restart, unavailable provider or database, and failed logout, each with accurate user feedback.
- **Least privilege.** The runtime role cannot read arbitrary tables or perform administrative actions, and unauthorized approval fails.
- **Limits and hygiene.** Atomic rate limits, retention cleanup, secret redaction, and deployed cookie and CSP checks.
- **Hosted smoke.** Keyboard navigation and an owner-driven Google sign-in on the hosted development origin.
- **Performance.** Signed-in authentication latency was measured in a small hosted sample. Pilot-load targets remain unverified until load testing.

## Audit records

The request audit records one bounded outcome code with the same server-generated request ID returned in the response. It covers these denials:
- origin and CSRF failures
- pending access and invalid sessions
- rate limits
- callback denials

Dependency failures are recorded too. Successful requests and voluntary OAuth cancellation create no records. If the audit write fails, the request fails closed with a sanitized unavailable response; a database outage cannot guarantee an audit write. Raw requests, callback queries, provider errors and credentials are never logged.

New audit rows record `database_principal` from PostgreSQL `session_user`, which identifies the authenticated database login rather than a caller-supplied actor label. A shared operator database credential does not prove which person ran a command. Individually attributable operator authentication is needed before more than one operator exists.

Technical denial records are deleted after 30 days. Operator admission records are kept until the target user is deleted.

## Implementation status

Hosted login, admission, revocation, CSRF, rate limits, auditing and retention are implemented and deployed for the owner-only development environment. Cookie flags and recovery after a full browser restart have been confirmed manually. An independent security review and pilot-scale load validation remain required before additional users are admitted.
