import type {
  Attempt,
  Context,
  Enrollment,
  SimulationState,
} from "./contracts.js";
import {
  eventSchema,
  type SimulationEvent,
  type TransitionResult,
} from "./contracts.js";
import {
  canonical,
  get,
  put,
  hold,
  terminal,
  fenceUnused,
  stop,
  addAction,
  advance,
  release,
  relevantAttempts,
  paused,
  key,
} from "./model.js";
import { evidenceReason, reason } from "./eligibility.js";
import { observe } from "./observations.js";
export function transition(
  input: SimulationState,
  raw: unknown,
  c: Context,
): TransitionResult {
  const parsed = eventSchema.safeParse(raw);
  if (!parsed.success)
    return { state: input, decision: "invalid-event", effects: [] };
  const v = parsed.data;
  if (
    !Number.isSafeInteger(c.now) ||
    c.now < input.clock ||
    v.receivedAt !== c.now ||
    v.at > v.receivedAt
  )
    return { state: input, decision: "invalid-time", effects: [] };
  const boundAccount = get(input.accounts, v.accountId);
  if (boundAccount && boundAccount.workspaceId !== v.workspaceId)
    return { state: input, decision: "workspace-mismatch", effects: [] };
  const fingerprint = canonical(v),
    previous = get(input.events, key(v.workspaceId, v.id));
  if (previous === fingerprint)
    return { state: input, decision: "duplicate-event", effects: [] };
  const s = structuredClone(input);
  s.clock = c.now;
  const finish = (
    decision: string,
    effects: TransitionResult["effects"] = [],
  ): TransitionResult => ({ state: s, decision, effects });
  if (previous) {
    s.conflicts.push(v);
    const original = s.history.find(
      (h) => h.id === v.id && h.workspaceId === v.workspaceId,
    );
    const affectedAccounts = new Set(
      [v.accountId, original?.accountId].filter((id): id is string => !!id),
    );
    for (const accountId of affectedAccounts) {
      const a = get(s.accounts, accountId);
      if (a) {
        a.paused = true;
        fenceUnused(s, accountId, c.now);
      }
      for (const e of Object.values(s.enrollments).filter(
        (e) => e.accountId === accountId,
      ))
        hold(e, "conflicting-event");
    }
    return finish("conflicting-event");
  }
  put(s.events, key(v.workspaceId, v.id), fingerprint);
  s.history.push(v);
  if (v.type === "configure") {
    try {
      c.calendar.local(c.now, v.policy.timezone);
    } catch {
      return finish("invalid-timezone");
    }
    const existing = get(s.accounts, v.accountId);
    if (existing) {
      if (existing.workspaceId !== v.workspaceId)
        return finish("workspace-mismatch");
      fenceUnused(s, v.accountId, c.now);
      existing.policy = v.policy;
      for (const e of Object.values(s.enrollments).filter(
        (e) => e.accountId === v.accountId && !terminal(e),
      )) {
        e.revision++;
        e.approvedRevision = null;
        hold(e, "approval");
      }
    } else
      put(s.accounts, v.accountId, {
        workspaceId: v.workspaceId,
        policy: v.policy,
        budgetTimezone: v.policy.timezone,
        paused: false,
        quota: true,
        restored: false,
        revoked: [],
        token: 0,
        nextAt: 0,
        budgets: [],
      });
    return finish("configured");
  }
  const account = get(s.accounts, v.accountId);
  if (!account) return finish("unknown-account");
  if (account.workspaceId !== v.workspaceId)
    return finish("workspace-mismatch");
  if (v.type === "enroll") {
    if (get(s.enrollments, v.enrollmentId))
      return finish("enrollment-id-exists");
    if (
      Object.values(s.enrollments).some(
        (e) =>
          e.accountId === v.accountId &&
          e.recipientId === v.recipientId &&
          !terminal(e),
      )
    )
      return finish("duplicate-enrollment");
    if (
      v.observation.identityMatches &&
      v.observation.connection === "Connected"
    )
      return finish("existing-connection-excluded");
    const e: Enrollment = {
      id: v.enrollmentId,
      accountId: v.accountId,
      recipientId: v.recipientId,
      campaignId: v.campaignId,
      enrolledAt: v.at,
      status: "Active",
      reason: "enrolled",
      connection: v.observation.connection,
      connectionAt: v.observation.connectionAt,
      observation: v.observation,
      revision: v.revision,
      approvedRevision: v.approved ? v.revision : null,
      fieldsComplete: v.fieldsComplete,
      note: v.note,
      gaps: [...account.policy.followupGapsMs],
      firstDelay: account.policy.firstMessageDelayMs,
      restored: account.restored,
    };
    put(s.enrollments, e.id, e);
    addAction(s, e, 0, c.now, c);
    if (e.connection === "Pending") {
      s.actions[c.id("action", key(e.id, "0"))]!.status = "Skipped";
      e.status = "Waiting";
      e.reason = "pending";
    }
    if (e.connection === "WithdrawnConfirmed") stop(s, e, "withdrawal");
    if (e.connection === "RejectedConfirmed") stop(s, e, "rejection");
    const issue = evidenceReason(e, c.now, account);
    if (issue) hold(e, issue);
    if (!v.approved) hold(e, "approval");
    if (!v.fieldsComplete) hold(e, "missing-fields");
    observe(s, e, v.observation, c);
    return finish(
      e.status === "Held"
        ? "enrolled-held"
        : e.status === "Stopped"
          ? "enrolled-stopped"
          : "enrolled",
    );
  }
  if (v.type === "quota") {
    account.quota = v.available;
    if (!v.available) fenceUnused(s, v.accountId, c.now);
    return finish("quota-updated");
  }
  if (v.type === "restore") {
    account.paused = true;
    account.restored = true;
    account.token++;
    for (const t of relevantAttempts(s, v.accountId)) {
      if (!account.revoked.includes(t.lease.executorId))
        account.revoked.push(t.lease.executorId);
    }
    fenceUnused(s, v.accountId, c.now);
    for (const e of Object.values(s.enrollments).filter(
      (e) => e.accountId === v.accountId && !terminal(e),
    )) {
      e.restored = true;
      hold(e, "restore-reconciliation");
    }
    return finish("restore-held");
  }
  if (v.type === "restore-reconciled") {
    if (!account.restored) return finish("not-restoring");
    if (relevantAttempts(s, v.accountId).length)
      return finish("unresolved-attempt");
    const affected = Object.values(s.enrollments).filter(
      (e) => e.accountId === v.accountId && !terminal(e),
    );
    if (
      affected.some(
        (e) =>
          evidenceReason(e, c.now, account) !== null ||
          e.observation.observedAt <
            s.history
              .filter(
                (x) => x.accountId === v.accountId && x.type === "restore",
              )
              .at(-1)!.receivedAt,
      )
    )
      return finish("restore-evidence-required");
    account.restored = false;
    for (const e of affected) e.restored = false;
    return finish("restore-reconciled");
  }
  if (v.type === "restart") {
    for (const t of relevantAttempts(s, v.accountId)) {
      if (t.phase === "claimed" && c.now >= t.lease.expiresAt)
        release(s, t, c.now);
      else if (t.phase !== "claimed") {
        t.phase = "unknown";
        s.actions[t.actionId]!.status = "OutcomeUnknown";
        hold(
          s.enrollments[s.actions[t.actionId]!.enrollmentId]!,
          "outcome-unknown",
        );
      }
    }
    return finish("restart-reconciled");
  }
  if (v.type === "revoke") {
    if (!account.revoked.includes(v.executorId))
      account.revoked.push(v.executorId);
    fenceUnused(s, v.accountId, c.now);
    return finish("revoked");
  }
  if (v.type === "pause") {
    if (v.scope === "account") {
      if (v.target !== v.accountId) return finish("target-mismatch");
      account.paused = v.paused;
    } else {
      const list = v.scope === "campaign" ? s.campaignPauses : s.personPauses;
      const target = key(v.accountId, v.target);
      if (v.paused && !list.includes(target)) list.push(target);
      if (!v.paused && list.includes(target))
        list.splice(list.indexOf(target), 1);
    }
    if (v.paused) fenceUnused(s, v.accountId, c.now);
    for (const e of Object.values(s.enrollments).filter(
      (e) => e.accountId === v.accountId && !terminal(e),
    )) {
      if (paused(s, e, account)) {
        e.status = "Paused";
      } else if (e.status === "Paused") {
        hold(e, "resume-revalidation");
      }
    }
    return finish(v.paused ? "paused" : "resume-revalidation");
  }
  if (v.type === "claim") {
    if (account.revoked.includes(v.executorId))
      return finish("executor-revoked");
    if (relevantAttempts(s, v.accountId).length)
      return finish("account-sender-busy");
    const candidates = Object.values(s.actions)
      .filter(
        (act) =>
          s.enrollments[act.enrollmentId]?.accountId === v.accountId &&
          ["Planned", "NotSent"].includes(act.status),
      )
      .sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id));
    let last = "no-action";
    for (const act of candidates) {
      const e = s.enrollments[act.enrollmentId]!;
      const why = reason(s, e, act, c);
      if (why) {
        last = why;
        continue;
      }
      const id = c.id("attempt", v.id);
      if (get(s.attempts, id)) return finish("id-collision");
      const t: Attempt = {
        id,
        actionId: act.id,
        accountId: v.accountId,
        revision: e.revision,
        lease: {
          executorId: v.executorId,
          token: ++account.token,
          expiresAt: c.now + account.policy.leaseMs,
        },
        phase: "claimed",
        authorizedAt: null,
        dispatched: false,
        conflict: false,
      };
      put(s.attempts, id, t);
      act.status = "Claimed";
      e.status = "Active";
      e.reason = "claimed";
      account.budgets.push({
        id,
        kind: act.kind,
        at: c.now,
        state: "reserved",
      });
      return finish("claimed");
    }
    return finish(last);
  }
  if ("enrollmentId" in v) {
    const e = get(s.enrollments, v.enrollmentId);
    if (!e || e.accountId !== v.accountId) return finish("enrollment-mismatch");
    if (v.type === "observe") {
      observe(s, e, v.observation, c);
      if (terminal(e) || e.status === "Held")
        fenceUnused(s, v.accountId, c.now);
      return finish(e.reason);
    }
    if (v.type === "stop") {
      stop(s, e, "owner-stop");
      fenceUnused(s, v.accountId, c.now);
      return finish("stopped");
    }
    if (v.type === "revise") {
      if (v.expectedRevision !== e.revision) return finish("revision-conflict");
      e.revision++;
      e.approvedRevision = null;
      fenceUnused(s, v.accountId, c.now);
      hold(e, "approval");
      return finish("approval-invalidated");
    }
    if (v.type === "approve") {
      if (v.revision !== e.revision) return finish("revision-conflict");
      e.approvedRevision = v.revision;
      e.fieldsComplete = v.fieldsComplete;
      e.gaps = [...account.policy.followupGapsMs];
      e.firstDelay = account.policy.firstMessageDelayMs;
      if (!terminal(e)) {
        for (const act of Object.values(s.actions).filter(
          (a) =>
            a.enrollmentId === e.id &&
            ["Planned", "NotSent"].includes(a.status),
        )) {
          if (act.ordinal > e.gaps.length + 1) {
            act.status = "Cancelled";
            continue;
          }
          if (act.ordinal === 1)
            act.dueAt = Math.max(act.dueAt, e.connectionAt + e.firstDelay);
          else if (act.ordinal > 1) {
            const preceding = Object.values(s.actions).find(
              (a) =>
                a.enrollmentId === e.id &&
                a.ordinal === act.ordinal - 1 &&
                a.confirmedAt !== null,
            );
            if (preceding)
              act.dueAt = Math.max(
                act.dueAt,
                preceding.confirmedAt! + e.gaps[act.ordinal - 2]!,
              );
          }
        }
      }
      advance(s, e, c);
      return finish("approved");
    }
  }
  if ("attemptId" in v) {
    const t = get(s.attempts, v.attemptId);
    if (!t || t.accountId !== v.accountId) return finish("attempt-mismatch");
    const act = s.actions[t.actionId]!,
      e = s.enrollments[act.enrollmentId]!;
    if (v.type === "authorize" || v.type === "may-have-sent") {
      if (
        account.revoked.includes(v.executorId) ||
        t.lease.executorId !== v.executorId ||
        t.lease.token !== v.token
      )
        return finish("authority-mismatch");
      if (c.now >= t.lease.expiresAt) return finish("expired-authority");
      const why = reason(s, e, act, c, t.id);
      if (why) return finish(why);
      if (v.type === "authorize") {
        if (!v.identityMatches) return finish("identity");
        if (v.revision !== e.revision || t.revision !== e.revision)
          return finish("revision-conflict");
        if (t.phase !== "claimed") return finish("already-authorized");
        // Cloud authorization conservatively records possible send BEFORE the local effect.
        t.phase = "possible";
        t.authorizedAt = c.now;
        t.lease.expiresAt = Math.min(
          t.lease.expiresAt,
          c.now + account.policy.authorizationMs,
        );
        act.status = "Authorized";
        return finish("authorized");
      }
      if (t.phase !== "possible" || t.authorizedAt === null || t.dispatched)
        return finish("not-dispatchable");
      t.dispatched = true;
      act.status = "MayHaveSent";
      account.nextAt = c.now + account.policy.spacingMs;
      return finish("simulated-send", [
        {
          type: "SIMULATED_SEND",
          command: {
            version: 1,
            source: "SYN",
            workspaceId: v.workspaceId,
            accountId: v.accountId,
            recipientId: e.recipientId,
            enrollmentId: e.id,
            actionId: act.id,
            attemptId: t.id,
            approvedRevision: e.revision,
            fencingToken: t.lease.token,
            expiresAt: t.lease.expiresAt,
            kind: act.kind,
          },
          actionId: act.id,
          attemptId: t.id,
        },
      ]);
    }
    if (v.type === "outcome" || v.type === "reconcile") {
      const resultKey = key(v.accountId, v.resultId),
        value = canonical({
          attemptId: v.attemptId,
          outcome: v.outcome,
          at: v.at,
          positiveEvidence: v.positiveEvidence,
        });
      const prior = get(s.results, resultKey);
      if (prior === value) return finish("duplicate-result");
      const contradicts =
        (t.phase === "sent" &&
          (v.outcome !== "CONFIRMED_SENT" || v.at !== act.confirmedAt)) ||
        (t.phase === "not-sent" && v.outcome !== "NOT_SENT");
      if (prior || contradicts) {
        s.conflicts.push(v);
        t.conflict = true;
        hold(e, "conflicting-outcome");
        return finish("conflicting-outcome");
      }
      if (v.outcome !== "OUTCOME_UNKNOWN" && !v.positiveEvidence)
        return finish("positive-evidence-required");
      if (
        v.outcome === "CONFIRMED_SENT" &&
        (t.authorizedAt === null || v.at < t.authorizedAt)
      )
        return finish("invalid-send-evidence");
      put(s.results, resultKey, value);
      if (v.outcome === "OUTCOME_UNKNOWN") {
        t.phase = "unknown";
        act.status = "OutcomeUnknown";
        hold(e, "outcome-unknown");
        return finish("outcome-unknown");
      }
      if (t.conflict) return finish("conflicting-outcome");
      if (v.outcome === "NOT_SENT") {
        release(s, t, c.now);
        return finish("not-sent");
      }
      if (t.phase === "sent") return finish("already-confirmed");
      t.phase = "sent";
      act.status = "ConfirmedSent";
      act.confirmedAt = v.at;
      const b = account.budgets.find((b) => b.id === t.id);
      if (b) {
        b.state = "spent";
        b.at = v.at;
      }
      account.nextAt = Math.max(
        account.nextAt,
        c.now + account.policy.spacingMs,
      );
      if (!terminal(e)) {
        if (act.kind === "invitation") {
          e.status = "Waiting";
          e.reason = "awaiting-acceptance";
        }
        advance(s, e, c);
      }
      return finish("confirmed-sent");
    }
  }
  return finish("unsupported-event");
}

export function runScenario(
  initial: SimulationState,
  events: readonly SimulationEvent[],
  context: Omit<Context, "now">,
): TransitionResult[] {
  let state = initial;
  return events.map((event) => {
    const result = transition(state, event, {
      ...context,
      now: event.receivedAt,
    });
    state = result.state;
    return result;
  });
}
