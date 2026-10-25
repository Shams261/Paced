import type {
  Account,
  Action,
  Context,
  Enrollment,
  SimulationState,
} from "./contracts.js";
import { terminal, paused, relevantAttempts } from "./model.js";
export function evidenceReason(
  e: Enrollment,
  now: number,
  a: Account,
): string | null {
  const o = e.observation;
  if (!o.identityMatches) return "identity";
  if (
    o.observedAt > now ||
    now - o.observedAt > a.policy.freshnessMs ||
    o.coverageTo > o.observedAt ||
    o.connectionAt > o.observedAt
  )
    return "stale-evidence";
  if (
    !o.complete ||
    o.coverageFrom > o.coverageTo ||
    o.coverageFrom > e.enrolledAt ||
    o.coverageTo < now - a.policy.freshnessMs
  )
    return "coverage";
  if (e.connection === "Unknown") return "connection-unknown";
  return null;
}
export function reason(
  s: SimulationState,
  e: Enrollment,
  act: Action,
  c: Context,
  ignoreAttempt?: string,
): string | null {
  const a = s.accounts[e.accountId]!;
  if (terminal(e)) return "terminal";
  if (a.restored || e.restored) return "restore-reconciliation";
  if (paused(s, e, a)) return "paused";
  if (!a.quota) return "quota";
  if (!a.policy.capability) return "capability-disabled";
  if (e.approvedRevision !== e.revision) return "approval";
  if (!e.fieldsComplete) return "missing-fields";
  if (
    e.status === "Held" &&
    [
      "ambiguous-message",
      "conflicting-outcome",
      "conflicting-event",
      "acceptance-order",
      "connection-conflict",
      "invalid-evidence-time",
      "identity",
    ].includes(e.reason)
  )
    return e.reason;
  const problem = evidenceReason(e, c.now, a);
  if (problem) return problem;
  if (
    act.kind === "invitation" &&
    (e.connection !== "NotConnected" || (e.note && !e.observation.noteAllowed))
  )
    return "invitation-evidence";
  if (act.kind === "message" && e.connection !== "Connected")
    return "awaiting-acceptance";
  if (relevantAttempts(s, e.accountId).some((t) => t.id !== ignoreAttempt))
    return "account-sender-busy";
  if (c.now < act.dueAt || c.now < a.nextAt) return "not-due";
  const local = c.calendar.local(c.now, a.policy.timezone);
  if (
    !a.policy.weekdays.includes(local.weekday) ||
    local.minute < a.policy.startMinute ||
    local.minute >= a.policy.endMinute
  )
    return "working-hours";
  const day = c.calendar.local(c.now, a.budgetTimezone).day;
  const used = a.budgets.filter(
    (b) =>
      b.kind === act.kind &&
      b.id !== ignoreAttempt &&
      b.state !== "released" &&
      (b.state === "reserved" ||
        c.calendar.local(b.at, a.budgetTimezone).day === day),
  ).length;
  if (
    used >=
    (act.kind === "invitation" ? a.policy.invitationCap : a.policy.messageCap)
  )
    return "daily-cap";
  return null;
}
