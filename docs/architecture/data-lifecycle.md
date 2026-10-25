# Data ownership and campaign lifecycle

The [product brief](../product/brief.md) defines approved behavior. This model implements that design on paper; schema and adapter evidence are future work. [ADR-0003](../decisions/0003-state-ownership.md) records the choice.

## Conceptual entities and tenant relationships

All domain IDs are opaque stable UUIDs. Every tenant-owned row carries `workspace_id`; child relationships use composite foreign keys including that ID, never just a caller-supplied object ID. The account-recipient key uses a verified stable LinkedIn identity, not a display name. If that identity cannot be resolved, hold import/enrollment instead of guessing or merging people.

| Entity | Minimum identity, time and revision fields | Ownership and purpose |
| --- | --- | --- |
| User / workspace | `user_id`, `workspace_id`, `created_at`, access revision, deletion time | One private workspace per pilot user; administrator allowlist separate; no teams |
| LinkedIn account | `account_id`, verified external identity, owner, timezone, settings revision, verified/created times | One bound account per user; account switch requires explicit verification/rebinding with old work held, never transfers queued recipients silently |
| Prospect / list membership | `prospect_id`, `account_id`, stable recipient key, selected fields, source/observed/created times; `list_id`, membership ID | One saved prospect per account-recipient, many named list memberships; removal from a list is not campaign deletion |
| Campaign / content revision | `campaign_id`, revision ID/number, created/updated times | Editable intent; optional note, first message, zero to three follow-ups, gaps and schedule |
| Approval | `approval_id`, approver, approved time, content/settings/recipient snapshot revision, rendered text per action/recipient | Immutable approval of named recipients and exact rendered outreach; does not mean sent |
| Enrollment | `enrollment_id`, account/recipient/campaign/approval IDs, revision, enrolled/stopped/completed times, baseline observation IDs | One person's sequence; holds active-recipient reservation until terminal |
| Logical action | `action_id`, enrollment ID, step ordinal/type, content revision, due time, state revision, confirmed/cancelled times | Stable intention to send one step; unique enrollment plus step; retries never create a new logical action |
| Attempt | `attempt_id`, action/executor/lease IDs, attempt number, claimed/authorized/may-have-sent/resolved times | Immutable outcome facts appended to an action; one uncertain attempt blocks further attempts |
| Observation | `observation_id`, account/recipient, observer/version, observed/received times, evidence reference, completeness and uncertainty | Minimal facts and relevant message direction/time/opaque fingerprint; no inbox bodies |
| Execution lease | `lease_id`, account/action/attempt/executor IDs, fencing token, issued/expires times | Temporary exclusive send authority; expiry is not proof that a send did not happen |

Use UTC instants for ordering and account IANA timezone for working hours, including daylight-saving changes. Revisions are monotonic integers; clients submit expected revisions and server time determines lease expiry. Preserve observation time and receipt time separately; late observations may add history without overwriting newer confirmed connection state. Do not infer chronology from network arrival alone.

Immutable facts include approvals, observations and attempt outcomes; editable intent has revisions. Immutability means no ordinary editing of facts, not exemption from authenticated deletion. Store selected profile fields and minimum observation metadata, not raw page HTML or an inbox archive. Rendered approved outreach is campaign history, not a copy of incoming private messages.

## Three independent state dimensions

| Dimension | Values and meaning |
| --- | --- |
| Connection | Unknown, NotConnected, Pending, Connected, WithdrawnConfirmed, RejectedConfirmed; every value has dated evidence, and ambiguous/conflicting evidence adds Needs verification |
| Enrollment | Active, Waiting, Paused, Held, Stopped, Completed; first four retain recipient exclusivity |
| Action | Planned, Due, Claimed, Authorized, MayHaveSent, ConfirmedSent, NotSent, OutcomeUnknown, Cancelled, Skipped |

Connection changes never erase a historical ConfirmedSent action. A withdrawal ends enrollment but an earlier invitation still remains sent in history. An active database uniqueness constraint covers `(account_id, recipient_key)` for Active, Waiting, Paused and Held enrollments across campaigns. Stopped/completed records release exclusivity but never auto-enroll or auto-reinvite. A later user enrollment needs fresh checks and a new explicit approval; unresolved older attempts still prohibit sends.

## Transition rules

| Trigger | Guards / interpretation | Result |
| --- | --- | --- |
| Enrollment requested | Fresh identity, baseline connection/conversation evidence, current recipient/content approval, no active reservation | Existing connection: reject all campaign enrollment/messaging. Pending invitation: enroll Waiting, invitation action Skipped with visible reason. NotConnected: plan approved invitation. Unknown: hold, do not send |
| Existing pending invitation | Pending before enrollment is not our send; no duplicate note or invitation | Wait without automatic timeout/withdrawal; show invitation step skipped |
| Acceptance observed after enrollment | Confirmed, account/recipient-matched evidence and fresh conversation check; valid approval | Connection Connected, make first regular message eligible. Never message merely because invitation is absent from a pending list |
| Incoming reply observed | Any relevant incoming message after enrollment, even a note reply before acceptance | Stop enrollment and cancel unsent actions; acceptance is no prerequisite |
| Manual outgoing observed | Outgoing after enrollment, not positively reconciled to our attempt | Manual takeover: stop and cancel. Historical outgoing before enrollment forms baseline only; ambiguous direction/time/attribution holds for verification |
| Rejection confirmed | Positive, identity-matched rejection evidence; never inferred from waiting or partial-list absence | Stop enrollment and cancel remaining actions; preserve sent history and reconcile any possible in-flight send |
| Withdrawal confirmed | Positive adapter evidence or separately verified outcome; absence from a list is insufficient | Stop enrollment and cancel remaining steps; do not change sent history |
| Stale, partial or conflicting observation | Missing coverage, account mismatch, uncertain identity, unavailable note allowance or incomplete baseline | Held / Needs verification; no inference of no reply, withdrawal or allowance |
| Action confirmed sent | Matching attempt evidence; no unresolved uncertainty | Preserve immutable sent fact; next step due no sooner than configured gap from confirmed event time; first message still requires acceptance |
| Attempt NotSent | Positive evidence no click/send occurred, or authorization safely revoked before may-have-sent | Retry same logical action only after fresh checks, backoff and limits; no advance |
| Attempt OutcomeUnknown | Send may have happened, confirmation absent | Hold sequence/account sender until reconciled; no retry or next step |
| Account, campaign or person pause | Any nonterminal enrollment; precedence: account then campaign then person | Prevent new authorizations; keep recipient reservation. Cancel an unused authorization; already possible sends enter reconciliation |
| Stop requested | Owner authorized, any nonterminal enrollment | Cancel remaining unsent intent and stop. A possible in-flight send cannot be undone; late result is still recorded without advancing sequence |
| Content, recipients or schedule edited | Expected revision; approved rendered output or execution settings change | Invalidate affected unsent approvals; revoke unused commands and hold until batch reapproval. Sent history remains fixed |
| Resume requested | All pause layers lifted, current approval, fresh evidence, no uncertain attempt, within current schedule/caps | Recompute due times; no accumulated catch-up burst; held work needs its specific cause resolved, not just a resume click |
| Final approved step confirmed | No pending steps or unresolved outcomes | Complete enrollment; never automatically restart |

New replies/manual activity observed late still stop remaining work even when the message predates observation receipt. Events whose time cannot be placed reliably relative to enrollment require verification. Page absence or a partial conversation view never establishes completeness. Recognizing our own outgoing action versus manual takeover is a feasibility gate; uncertain attribution must not enable another send.

## Explicit initial configuration and engineering defaults

Product-approved: caps and working hours are account-wide across campaigns; user can pause account/campaign/person; gaps are configurable; there is no enrollment deadline. Ordinary configuration does not guarantee platform safety.

Provisional engineering defaults to validate before execution: sends disabled at account creation; configured daily invitation cap 10 and message cap 20, one action per account per 120 seconds, Monday-Friday 09:00-17:00 in an explicitly selected timezone (no guessed timezone). First message delay after acceptance is 24 hours; enabled follow-up gaps default to 3 days; up to three, each optional. A 24-hour minimum gap is only a provisional proposal to resolve during S2-001 refinement, not a user-approved fixed minimum; approved product behavior keeps gaps configurable. Cap increases need visible account settings confirmation and cannot exceed an operator-configured pilot ceiling. Actual LinkedIn allowance may be lower and always blocks sending when unavailable/unknown. These values are workload defaults, not recommendations that these volumes are safe.

Cap counters include confirmed sends and unresolved may-have-sent reservations. Invitation and message counters are separate, shared across campaigns. Conservative handling of positively observed manual sends also consumes the applicable daily budget; incomplete manual activity visibility cannot establish an exact LinkedIn-wide total. Counters use local calendar days with UTC window boundaries; moving timezone/settings cannot reset already consumed budget or bypass spacing. Following long offline/pause periods, schedule from the next valid window with minimum spacing and fairness by due time; do not dispatch all overdue actions together.

The [execution contract](api-execution.md) defines provisional freshness and lease defaults. Read-only feasibility work must establish what observation coverage can actually be claimed. The campaign simulator tests deterministic transition fixtures, and controlled execution gates must approve every real action capability. No engineering default has been tested here.
