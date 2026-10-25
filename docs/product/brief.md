# Product brief

## Problem and approved baseline

Help invited users manage selected LinkedIn prospects, approved outreach and follow-ups without repetitive tracking. Example: select engineers from standard LinkedIn search, save them in a list, review rendered outreach and follow an approved sequence.

This hosted MVP baseline was approved on 30 September 2026. It supersedes an earlier local-only scope and a proposed 30-day enrollment deadline. The current [architecture](../architecture/README.md) is an accepted design, not a working LinkedIn integration.

## Audience, deployment and data

- Invite-only global pilot: up to 100 users, one LinkedIn account per user, 1,000 saved prospects per account. Support Free/Premium only where the observed account actually supports the capability.
- Hosted dashboard and central campaign data; actual LinkedIn execution only in the user's signed-in browser. Offline browser means wait. Never upload LinkedIn passwords or session cookies. Product Google sign-in is separate and restricted by an administrator-managed allowlist.
- Development database and hosted product data are distinct. Free hosting until revenue or a separately approved upgrade; quota limits may require a smaller pilot or paused admission.
- Keep prospect lists and campaign history until user deletion. No silent deletion to fit quota. Store selected fields and minimal observation metadata, not a full inbox archive or incoming message bodies.

## Selection, approval and sequence rules

Start with standard LinkedIn search; user chooses profiles. Lists organize prospects and do not automatically enroll them. Batch approval covers recipients and exact rendered outreach: optional invitation note, regular first message after acceptance, zero to three optional follow-ups and configurable gaps. Missing profile values must not be invented. Unavailable or unknown note allowance must not silently drop an approved note.

Existing connections at enrollment are excluded from campaign messaging as well as invitations. Existing pending invitations receive no duplicate invitation or note; show that invitation step as skipped, then wait until resolved. There is no automatic timeout or withdrawal. Confirmed acceptance after enrollment makes the first message eligible only after fresh conversation checks and current approval.

An observed incoming reply ends the person's sequence, including a reply to an invitation note before acceptance. An observed manual outgoing message after enrollment is manual takeover and ends it. Historical messages before enrollment form a baseline; they are not automatically new manual activity. Ambiguous timestamps or attribution hold work for verification.

Confirmed rejection also ends enrollment and cancels remaining actions, with no automatic re-invitation. An unaccepted invitation remains pending; disappearance alone cannot prove rejection. This rule is tested synthetically; live rejection detection is unverified.

Confirmed withdrawal ends enrollment and cancels remaining actions. Absence from a list does not prove withdrawal; ambiguous evidence means hold/Needs verification. History that an invitation was sent remains true even if latest connection state changes.

One active sequence per `(LinkedIn account, recipient)` includes paused, held and waiting sequences across all campaigns. A prospect may be in many lists; second enrollment is blocked, not queued for automatic restart. Stopped/completed enrollments do not automatically enroll or reinvite again.

Account-wide invitation/message caps and working hours coordinate campaigns. Queue and hold reasons are visible; pause account, campaign or person. Configuration defaults are explicit in [lifecycle](../architecture/data-lifecycle.md) and are workload controls, not platform safety guarantees. Resuming work requires fresh checks and current approval and never causes a catch-up burst. Edits affecting unsent approved outreach require reapproval.

## Accepted technical direction and limits

React + TypeScript + Vite dashboard; Chrome Manifest V3 extension with separate adapter; TypeScript modular Hono backend on Cloudflare Workers; Cloudflare Pages static hosting; Supabase PostgreSQL + Auth with Google OAuth and initial Canada (Central) database region. SQL migrations and PostgreSQL durable queue; no Redis dependency. The pure engine is independent of browser selectors, storage and cloud SDKs. [ADRs](../decisions/README.md) explain alternatives and consequences.

No AI, teams, billing, CRM, Sales Navigator, email outreach or cloud browser execution in MVP. Personalization with AI is deferred; simple approved field substitution cannot invent missing facts.

## Current local implementation

A pure offline [campaign simulator](../engineering/campaign-simulator.md) exercises the sequence rules with synthetic events. The hosted dashboard now provides login, saved fictional prospects and campaigns, export, deletion and quota guards. Synthetic testing does not resolve live capability gaps.

## Evidence and next work

Product choices are user requirements, not evidence of LinkedIn reliability or platform approval. Preserve the [research labels and capability gaps](feasibility.md). Live sending stays disabled until read-only feasibility and controlled execution gates pass.
