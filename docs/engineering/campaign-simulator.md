# Campaign simulator guide

The simulator runs synthetic events through the pure campaign engine. It has no LinkedIn adapter, network client, dashboard, database or real sending function.

## Run locally

Use Node 26.10.0 (recorded in `.node-version`) and npm. Install the locked local dependencies with `npm ci --ignore-scripts`. No global installation or cloud account is required.

```bash
npm run typecheck
npm test
npm run format:check
npm run simulate -- --list
npm run simulate -- pending-reply
npm run simulate -- unknown-restart
npm run simulate -- acceptance-message --json
```

The runner uses `node --import tsx` to avoid the tsx CLI's temporary IPC socket. Output explicitly says SYN or SIMULATED_SEND. It never sends a message. Unknown scenario names exit unsuccessfully. JSON output includes a full synthetic transition trace; do not replace fixtures with real profile or message data.

## Visual demo

Run `npm run demo` to open a loopback-only server. It prints its URL; the operating system selects an available port using port 0. Existing listeners are untouched. Open the printed URL, select a scenario and use Next step, Run to end or Reset. The server generates traces from the same engine and serves only its fixed demo assets. It stores no browser data and does not send outreach. Stop this server with Ctrl+C in its own terminal; do not kill unrelated processes. Restarting may choose a different port.

The view is plain HTML/CSS/JavaScript for this local demonstration; the accepted React/Vite hosted-product architecture is unchanged. Node socket binding may need local tool permission in restricted environments.

## Code map and public interface

| File | Responsibility |
| --- | --- |
| [Contracts](../../packages/campaign-engine/src/contracts.ts) | Strict versioned event schemas, separate state types and synthetic observation metadata |
| [Model](../../packages/campaign-engine/src/model.ts) | Action progression, reservations, immutable-input helpers and conservative fencing |
| [Eligibility](../../packages/campaign-engine/src/eligibility.ts) | Evidence, approval, pause, schedule, quota, spacing and cap checks |
| [Observations](../../packages/campaign-engine/src/observations.ts) | Dated connection facts, reply/manual stop and uncertain evidence handling |
| [Transitions](../../packages/campaign-engine/src/transition.ts) | Event validation, idempotency, authority, outcomes and replay |
| [Calendar](../../packages/campaign-engine/src/calendar.ts) | Explicit IANA timezone conversion using standard Intl support |
| [Fixtures](../../tools/campaign-simulator/src/fixtures.ts) | Synthetic policies, events and five named demonstration scenarios |

The public package exports `initialState`, `transition`, `runScenario`, `intlCalendar` and contract types/schemas. `transition(state, event, context)` returns a new state, reason and simulated effects. The supplied context owns time, deterministic ID generation and calendar conversion. Preserve the returned state between calls. Use monotonically increasing receipt time; event time can be earlier, for late evidence. Input state is a trusted internal snapshot produced by the engine, not an arbitrary uploaded JSON object.

Every event names workspace/account and a version. IDs are opaque; the simulator's readable IDs are wholly invented. The caller supplies unique deterministic IDs. This account/workspace consistency check is not authentication or production tenant isolation. Production imports must perform their own identity and access validation.

## State and safety rules

Connection, enrollment and action states are independent. Facts remain in history even if a sequence stops. Identical event IDs are harmless on replay; conflicting events pause affected accounts and hold enrollments. Confirmed result contradictions, including conflicting event times, require investigation rather than silent overwrite.

A claim reserves budget and the account sender. Authorization records possible send before any simulated effect. Restart after that point holds; it never interprets expiry as proof of non-send. Positive outcome evidence can reconcile an uncertain attempt. Duplicate outcomes do not consume or release budget twice. Stop cancels unsent intent but preserves a possible in-flight result. Late confirmation after an approval change records history and waits for reapproval before scheduling the next step.

Only positive manual attribution stops for manual takeover. An own-message observation must refer to an already positively reconciled attempt; otherwise it holds. A separate outcome event provides that reconciliation. A partial conversation can provide a positive reply stop, but cannot prove no reply. Identity mismatches cannot reuse an older fresh observation to authorize work.

## Scheduling choices and conservative limits

All policy values are injected. The provisional-defaults fixture exercises the architecture proposals without approving production defaults or imposing a 24-hour minimum. Zero delays still obey all guards. Due actions are chosen by due time then stable action ID. No background timer runs: the scenario supplies claim events.

Working windows use the current explicit timezone. The budget calendar remains bound to the account's original timezone for this simulator, so changing schedule timezone cannot reset consumed budget. This is a conservative simulation rule; any future budget-calendar migration needs a separately designed overlap-safe policy. Unresolved reservations count across midnight; known spent entries count on their fixed local day. Spacing also starts conservatively from confirmation receipt, preventing a late result from causing catch-up bursts.

Policy changes invalidate approvals. An enrollment snapshots delay configuration; reapproval adopts the latest configured gaps for future progression. Already planned unsent steps are cancelled if removed; increased delays move their due times later, while decreased delays do not pull an existing due time earlier. Current approval/evidence/schedule guards still apply. This simulator models revision validity, not rendered text editing. Held conflicts require investigation; there is no generic resume command that clears every hold.

Pausing or revising a recipient conservatively fences the entire account's outstanding authority. This can delay unrelated work, but cannot authorize an extra send. Restore starts account-paused, invalidates outstanding authority, and requires no unresolved attempts plus fresh observation evidence before reconciliation can clear the restore hold. Resume is a separate action. A snapshot cannot recover facts lost before its cutoff; external journal evidence is a later integration requirement.

## Confirmed rejection

The `confirmed-rejection` scenario adds positive synthetic rejection evidence and shows the terminal stop. Pending remains Waiting; an unclear disappearance remains Held. Sent history survives rejection, and a late result never restarts the sequence. Live LinkedIn rejection detection remains unverified.

## Test scope

Tests assert intermediate decisions, final state, effect uniqueness, reservations, source boundaries, deterministic replay and CLI behavior. Event-order permutations cover stop/pause/revision/restart combinations. Synthetic faults do not test actual browser crashes, persistent storage, database concurrency, backup files, network latency or LinkedIn detection. No live capability is enabled by this package.
