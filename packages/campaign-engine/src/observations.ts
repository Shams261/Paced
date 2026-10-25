import type {
  Context,
  Enrollment,
  Observation,
  SimulationState,
} from "./contracts.js";
import {
  terminal,
  stop,
  hold,
  key,
  get,
  addAction,
  relevantAttempts,
} from "./model.js";
import { evidenceReason } from "./eligibility.js";
export function observe(
  s: SimulationState,
  e: Enrollment,
  o: Observation,
  c: Context,
): void {
  const a = s.accounts[e.accountId]!;
  if (!o.identityMatches) {
    hold(e, "identity");
    return;
  }
  if (
    o.connectionAt > o.observedAt ||
    o.observedAt > c.now ||
    o.coverageFrom > o.coverageTo ||
    o.coverageTo > o.observedAt
  ) {
    hold(e, "invalid-evidence-time");
    return;
  }
  const m = o.message;
  if (m && (m.at === null || m.at > o.observedAt)) {
    hold(e, "ambiguous-message");
    return;
  }
  if (m && m.at! >= e.enrolledAt) {
    if (m.direction === "incoming") stop(s, e, "reply");
    else if (m.attribution === "manual") {
      stop(s, e, "manual-takeover");
      const budgetId = key("manual", e.recipientId, m.fingerprint);
      if (!a.budgets.some((b) => b.id === budgetId))
        a.budgets.push({
          id: budgetId,
          kind: "message",
          at: m.at!,
          state: "spent",
        });
    } else if (m.attribution === "unknown") hold(e, "ambiguous-message");
    else {
      const t = m.attemptId ? get(s.attempts, m.attemptId) : undefined;
      if (
        !t ||
        t.accountId !== e.accountId ||
        s.actions[t.actionId]?.enrollmentId !== e.id ||
        t.phase !== "sent"
      )
        hold(e, "ambiguous-message");
    }
  }
  if (o.observedAt < e.observation.observedAt) return;
  e.observation = o;
  if (o.connectionAt >= e.connectionAt) {
    if (o.connectionAt === e.connectionAt && o.connection !== e.connection) {
      hold(e, "connection-conflict");
      return;
    }
    const previous = e.connection;
    e.connection = o.connection;
    e.connectionAt = o.connectionAt;
    if (o.connection === "WithdrawnConfirmed") stop(s, e, "withdrawal");
    if (o.connection === "RejectedConfirmed") stop(s, e, "rejection");
    if (
      !terminal(e) &&
      o.connection === "Connected" &&
      previous !== "Connected"
    ) {
      if (o.connectionAt <= e.enrolledAt) {
        hold(e, "acceptance-order");
        return;
      }
      // Acceptance can resolve waiting only after the invitation attempt is resolved.
      if (!relevantAttempts(s, e.accountId).length) {
        const invitation = Object.values(s.actions).find(
          (x) => x.enrollmentId === e.id && x.ordinal === 0,
        );
        if (
          invitation &&
          !["ConfirmedSent", "Skipped"].includes(invitation.status)
        ) {
          invitation.status = "Skipped";
        }
        addAction(s, e, 1, o.connectionAt + e.firstDelay, c);
      }
    }
  }
  if (
    !terminal(e) &&
    relevantAttempts(s, e.accountId).some(
      (t) => t.phase === "unknown" || t.conflict,
    )
  ) {
    hold(e, "outcome-unknown");
    return;
  }
  if (
    !terminal(e) &&
    ![
      "ambiguous-message",
      "conflicting-outcome",
      "conflicting-event",
      "acceptance-order",
      "connection-conflict",
    ].includes(e.reason)
  ) {
    const issue = evidenceReason(e, c.now, a);
    if (issue) hold(e, issue);
    else {
      e.status = e.connection === "Pending" ? "Waiting" : "Active";
      e.reason = "observed";
    }
  }
}
