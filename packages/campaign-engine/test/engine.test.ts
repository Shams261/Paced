import { describe, expect, it } from "vitest";
import {
  initialState,
  transition,
  runScenario,
  intlCalendar,
  type SimulationState,
  type Policy,
  type Observation,
} from "../src/index.js";
import {
  T,
  context,
  configure,
  enroll,
  observation,
  event,
  scenarios,
  simulate,
} from "../../../tools/campaign-simulator/src/fixtures.js";

function harness(
  policy: Partial<Policy> = {},
  baseline: Partial<Observation> = {},
) {
  let state = initialState(),
    serial = 0,
    now = T;
  function send(payload: Record<string, unknown>, at = now) {
    now = at;
    const result = transition(state, event(`e${++serial}`, at, payload), {
      ...context,
      now: at,
    });
    state = result.state;
    return result;
  }
  send({ ...configure, policy: { ...configure.policy, ...policy } });
  send({ ...enroll, observation: observation(T, baseline) });
  return {
    send,
    get state() {
      return state;
    },
    get enrollment() {
      return state.enrollments["enrollment-a"]!;
    },
    get attempt() {
      return Object.values(state.attempts).at(-1)!;
    },
    claim(at = now, executorId = "executor-a") {
      return send({ type: "claim", executorId }, at);
    },
    authorize(at = now) {
      const t = Object.values(state.attempts).at(-1)!;
      return send(
        {
          type: "authorize",
          attemptId: t.id,
          executorId: t.lease.executorId,
          token: t.lease.token,
          revision: state.enrollments["enrollment-a"]!.revision,
          identityMatches: true,
        },
        at,
      );
    },
    dispatch(at = now) {
      const t = Object.values(state.attempts).at(-1)!;
      return send(
        {
          type: "may-have-sent",
          attemptId: t.id,
          executorId: t.lease.executorId,
          token: t.lease.token,
        },
        at,
      );
    },
    outcome(
      outcome = "CONFIRMED_SENT",
      at = now,
      extra: Record<string, unknown> = {},
    ) {
      const t = Object.values(state.attempts).at(-1)!;
      return send(
        {
          type: "outcome",
          attemptId: t.id,
          resultId: `r${serial}`,
          outcome,
          positiveEvidence: true,
          ...extra,
        },
        at,
      );
    },
    observe(patch: Partial<Observation>, at = now) {
      return send(
        {
          type: "observe",
          enrollmentId: "enrollment-a",
          observation: observation(at, patch),
        },
        at,
      );
    },
  };
}
const assertInvariants = (s: SimulationState) => {
  const reservations = Object.values(s.enrollments)
    .filter((e) => !["Stopped", "Completed"].includes(e.status))
    .map((e) => JSON.stringify([e.accountId, e.recipientId]));
  expect(new Set(reservations).size).toBe(reservations.length);
  for (const accountId of Object.keys(s.accounts))
    expect(
      Object.values(s.attempts).filter(
        (t) =>
          t.accountId === accountId &&
          ["claimed", "possible", "unknown"].includes(t.phase),
      ).length,
    ).toBeLessThanOrEqual(1);
};

describe("synthetic acceptance and reproducibility", () => {
  for (const [name, scenario] of Object.entries(scenarios))
    it(name, () => {
      const trace = simulate(name);
      expect(trace.at(-1)?.decision).toBe(scenario.expectedLastDecision);
      expect(simulate(name)).toEqual(trace);
      trace.forEach((r) => assertInvariants(r.state));
      const replay = runScenario(
        initialState(),
        scenario.events.flatMap((e) => [e, e]),
        context,
      );
      expect(replay.flatMap((r) => r.effects)).toEqual(
        trace.flatMap((r) => r.effects),
      );
      expect(replay.at(-1)?.state).toEqual(trace.at(-1)?.state);
    });
  it("never mutates input and rejects invalid contracts/time", () => {
    const before = initialState(),
      snapshot = structuredClone(before);
    transition(before, configure, { ...context, now: T });
    expect(before).toEqual(snapshot);
    for (const raw of [
      { ...configure, version: 2 },
      { ...configure, policy: { ...configure.policy, spacingMs: -1 } },
      { ...configure, receivedAt: T - 1 },
      { ...configure, extra: "field" },
    ])
      expect(transition(before, raw, { ...context, now: T }).effects).toEqual(
        [],
      );
    expect(
      transition(
        before,
        {
          ...configure,
          policy: { ...configure.policy, timezone: "Invalid/Zone" },
        },
        { ...context, now: T },
      ).decision,
    ).toBe("invalid-timezone");
  });
});

describe("enrollment and observations", () => {
  it("excludes existing connections from all outreach", () => {
    const h = harness({}, { connection: "Connected" });
    expect(h.enrollment).toBeUndefined();
    expect(h.claim().decision).toBe("no-action");
  });
  it("skips pending invitations and has no expiry", () => {
    const h = harness({}, { connection: "Pending" });
    expect(h.enrollment.status).toBe("Waiting");
    expect(Object.values(h.state.actions)[0]?.status).toBe("Skipped");
    expect(h.claim(T + 365 * 86_400_000).decision).toBe("no-action");
  });
  it.each([
    { identityMatches: false },
    { complete: false },
    { connection: "Unknown" },
  ] as Partial<Observation>[])("holds unverified baseline %j", (patch) => {
    const h = harness({}, patch);
    expect(h.enrollment.status).toBe("Held");
    expect(h.claim().decision).not.toBe("claimed");
  });
  it("holds unknown note allowance and missing fields", () => {
    const h = harness({}, { noteAllowed: false });
    expect(h.claim().decision).toBe("invitation-evidence");
    h.send({
      type: "approve",
      enrollmentId: "enrollment-a",
      revision: 1,
      fieldsComplete: false,
    });
    expect(h.claim().decision).toBe("missing-fields");
  });
  it.each(["waiting", "held", "paused", "active"])(
    "keeps %s reservations across campaigns",
    (mode) => {
      const h = harness(
        {},
        mode === "waiting"
          ? { connection: "Pending" }
          : mode === "held"
            ? { complete: false }
            : {},
      );
      if (mode === "paused")
        h.send({
          type: "pause",
          scope: "person",
          target: "enrollment-a",
          paused: true,
        });
      expect(
        h.send({
          ...enroll,
          id: "second",
          enrollmentId: "other",
          campaignId: "other-campaign",
        }).decision,
      ).toBe("duplicate-enrollment");
    },
  );
  it("uses identity keys rather than names and enforces account binding", () => {
    const h = harness();
    expect(
      h.send({
        ...enroll,
        id: "other",
        enrollmentId: "other",
        recipientId: "recipient-b",
      }).decision,
    ).toBe("enrolled");
    h.send({ ...configure, id: "config-b", accountId: "account-b" });
    expect(
      h.send({
        type: "stop",
        accountId: "account-b",
        enrollmentId: "enrollment-a",
      }).decision,
    ).toBe("enrollment-mismatch");
  });
  it.each(["incoming", "outgoing"])(
    "stops %s after enrollment before acceptance",
    (direction) => {
      const h = harness({}, { connection: "Pending" });
      h.observe(
        {
          connection: "Pending",
          message: {
            direction: direction as "incoming" | "outgoing",
            at: T + 1,
            attribution: "manual",
            fingerprint: "m1",
          },
        },
        T + 1,
      );
      expect(h.enrollment.status).toBe("Stopped");
      expect(h.claim().decision).toBe("no-action");
    },
  );
  it("does not stop on historical messages; unknown attribution or time holds", () => {
    const h = harness();
    h.observe(
      {
        message: {
          direction: "incoming",
          at: T - 1,
          attribution: "unknown",
          fingerprint: "old",
        },
      },
      T + 1,
    );
    expect(h.enrollment.status).toBe("Active");
    h.observe(
      {
        message: {
          direction: "outgoing",
          at: T + 1,
          attribution: "unknown",
          fingerprint: "new",
        },
      },
      T + 2,
    );
    expect(h.claim().decision).toBe("ambiguous-message");
    h.observe(
      {
        message: {
          direction: "incoming",
          at: null,
          attribution: "unknown",
          fingerprint: "unknown",
        },
      },
      T + 3,
    );
    expect(h.claim().decision).not.toBe("claimed");
  });
  it("positive reply stops even with partial coverage", () => {
    const h = harness();
    h.observe(
      {
        complete: false,
        message: {
          direction: "incoming",
          at: T + 1,
          attribution: "unknown",
          fingerprint: "m",
        },
      },
      T + 2,
    );
    expect(h.enrollment.reason).toBe("reply");
  });
  it("partial disappearance holds and cannot prove withdrawal", () => {
    const h = harness({}, { connection: "Pending" });
    h.observe({ connection: "Unknown", complete: false }, T + 1);
    expect(h.enrollment.status).toBe("Held");
    expect(h.enrollment.reason).not.toBe("withdrawal");
  });
  it("withdrawal stops but preserves confirmed send history", () => {
    const h = harness();
    h.claim();
    h.authorize();
    h.dispatch();
    h.outcome();
    h.observe({ connection: "WithdrawnConfirmed" }, T + 1);
    expect(h.enrollment.status).toBe("Stopped");
    expect(Object.values(h.state.actions)[0]?.status).toBe("ConfirmedSent");
  });
  it("ignores older connection state but still processes late reply", () => {
    const h = harness({}, { connection: "Pending" });
    h.observe({ connection: "Connected" }, T + 10);
    h.observe(
      {
        connection: "Pending",
        observedAt: T + 5,
        connectionAt: T + 5,
        coverageTo: T + 5,
      },
      T + 20,
    );
    expect(h.enrollment.connection).toBe("Connected");
    h.observe(
      {
        connection: "Pending",
        observedAt: T + 5,
        connectionAt: T + 5,
        coverageTo: T + 5,
        message: {
          direction: "incoming",
          at: T + 2,
          attribution: "unknown",
          fingerprint: "late",
        },
      },
      T + 21,
    );
    expect(h.enrollment.status).toBe("Stopped");
  });
  it("acceptance needs dated evidence, then a fresh complete conversation check", () => {
    const h = harness({}, { connection: "Pending" });
    h.observe({ connection: "Connected", complete: false }, T + 1);
    expect(h.claim().decision).toBe("coverage");
    h.observe({ connection: "Connected", connectionAt: T + 1 }, T + 2);
    expect(h.claim().decision).toBe("claimed");
  });
  it("rejects conflicting or future evidence times", () => {
    const h = harness();
    h.observe({ connection: "Connected", connectionAt: T }, T + 1);
    expect(h.claim().decision).not.toBe("claimed");
    const b = harness();
    b.observe({ observedAt: T + 10 }, T + 1);
    expect(b.claim().decision).not.toBe("claimed");
  });
});

describe("authority, outcomes and recovery", () => {
  it("one executor claims; wrong identity, executor, token and revision cannot authorize", () => {
    const h = harness();
    expect(h.claim().decision).toBe("claimed");
    expect(h.claim(T, "executor-b").decision).toBe("account-sender-busy");
    for (const patch of [
      { identityMatches: false },
      { executorId: "executor-b" },
      { token: 99 },
      { revision: 2 },
    ])
      expect(
        h.send({
          type: "authorize",
          attemptId: h.attempt.id,
          executorId: "executor-a",
          token: 1,
          revision: 1,
          identityMatches: true,
          ...patch,
        }).decision,
      ).not.toBe("authorized");
    expect(h.authorize().decision).toBe("authorized");
    expect(h.dispatch().effects).toHaveLength(1);
    expect(h.dispatch().effects).toHaveLength(0);
  });
  it("preauthorization crash reclaims only after expiry; possible send never does", () => {
    const h = harness();
    h.claim();
    h.send({ type: "restart" }, T + 60_000);
    expect(h.attempt.phase).toBe("not-sent");
    h.observe({}, T + 61_000);
    expect(h.claim().decision).toBe("claimed");
    h.authorize();
    h.send({ type: "restart" }, T + 200_000);
    expect(h.attempt.phase).toBe("unknown");
    expect(h.claim().decision).toBe("account-sender-busy");
  });
  it("revocation fences unused authority and blocks old executor", () => {
    const h = harness();
    h.claim();
    h.send({ type: "revoke", executorId: "executor-a" });
    expect(h.authorize().decision).toBe("authority-mismatch");
    expect(h.claim().decision).toBe("executor-revoked");
  });
  it.each(["account", "campaign", "person"])(
    "pause layer %s cannot be bypassed",
    (scope) => {
      const h = harness();
      h.claim();
      h.send({
        type: "pause",
        scope,
        target:
          scope === "account"
            ? "account-a"
            : scope === "campaign"
              ? "campaign-a"
              : "enrollment-a",
        paused: true,
      });
      h.send({
        type: "pause",
        scope: scope === "account" ? "person" : "account",
        target: scope === "account" ? "enrollment-a" : "account-a",
        paused: false,
      });
      expect(h.claim().decision).toBe("paused");
    },
  );
  it("stop cancels before authorization, preserves possible send after it", () => {
    const before = harness();
    before.claim();
    before.send({ type: "stop", enrollmentId: "enrollment-a" });
    expect(before.authorize().effects).toHaveLength(0);
    const h = harness();
    h.claim();
    h.authorize();
    h.send({ type: "stop", enrollmentId: "enrollment-a" });
    expect(h.attempt.phase).toBe("unknown");
    h.outcome();
    expect(h.enrollment.status).toBe("Stopped");
    expect(Object.values(h.state.actions)).toHaveLength(1);
  });
  it("unknown holds across midnight and needs positive outcome evidence", () => {
    const h = harness();
    h.claim();
    h.authorize();
    h.outcome("OUTCOME_UNKNOWN");
    h.send({ type: "restart" }, T + 86_400_000);
    expect(h.claim().decision).toBe("account-sender-busy");
    expect(
      h.outcome("NOT_SENT", T + 86_400_000, { positiveEvidence: false })
        .decision,
    ).toBe("positive-evidence-required");
    h.outcome("NOT_SENT");
    h.observe({}, T + 86_401_000);
    expect(h.claim().decision).toBe("claimed");
  });
  it("NOT_SENT releases once and never advances", () => {
    const h = harness();
    h.claim();
    h.outcome("NOT_SENT", T, { resultId: "r" });
    h.outcome("NOT_SENT", T, { resultId: "r" });
    expect(
      h.state.accounts["account-a"]!.budgets.filter(
        (b) => b.state === "released",
      ),
    ).toHaveLength(1);
    expect(Object.values(h.state.actions)).toHaveLength(1);
    expect(h.claim().decision).toBe("not-due");
  });
  it("duplicate confirmation does not double spend; contradiction blocks account", () => {
    const h = harness();
    h.claim();
    h.authorize();
    h.outcome("CONFIRMED_SENT", T, { resultId: "result" });
    expect(
      h.outcome("CONFIRMED_SENT", T, { resultId: "result" }).decision,
    ).toBe("duplicate-result");
    expect(h.outcome("NOT_SENT").decision).toBe("conflicting-outcome");
    expect(h.claim().decision).toBe("account-sender-busy");
  });
  it("approval changes fence old authorization and require current revision", () => {
    const h = harness();
    h.claim();
    h.send({
      type: "revise",
      enrollmentId: "enrollment-a",
      expectedRevision: 1,
    });
    expect(h.claim().decision).toBe("approval");
    expect(
      h.send({
        type: "approve",
        enrollmentId: "enrollment-a",
        revision: 1,
        fieldsComplete: true,
      }).decision,
    ).toBe("revision-conflict");
    h.send({
      type: "approve",
      enrollmentId: "enrollment-a",
      revision: 2,
      fieldsComplete: true,
    });
    h.observe({}, T + 1000);
    expect(h.claim().decision).toBe("claimed");
  });
  it("quota exhaustion stops new claims while stop and outcomes remain available", () => {
    const h = harness();
    h.claim();
    h.authorize();
    h.send({ type: "quota", available: false });
    h.send({ type: "stop", enrollmentId: "enrollment-a" });
    expect(h.outcome().decision).toBe("confirmed-sent");
    expect(h.enrollment.status).toBe("Stopped");
    const b = harness();
    b.send({ type: "quota", available: false });
    expect(b.claim().decision).toBe("quota");
  });
  it("restore starts paused, requires fresh reconciliation and revokes old executor", () => {
    const h = harness();
    h.claim();
    h.authorize();
    h.send({ type: "restore" }, T + 1);
    expect(h.send({ type: "restore-reconciled" }).decision).toBe(
      "unresolved-attempt",
    );
    h.outcome("NOT_SENT");
    expect(h.send({ type: "restore-reconciled" }).decision).toBe(
      "restore-evidence-required",
    );
    h.observe({}, T + 1001);
    expect(h.send({ type: "restore-reconciled" }).decision).toBe(
      "restore-reconciled",
    );
    expect(h.claim(T + 1001, "executor-b").decision).toBe("paused");
    h.send({
      type: "pause",
      scope: "account",
      target: "account-a",
      paused: false,
    });
    expect(h.claim(T + 1001, "executor-b").decision).toBe("claimed");
  });
  it("terminal work never auto-restarts and older uncertainty still blocks new enrollment sends", () => {
    const h = harness();
    h.claim();
    h.authorize();
    h.send({ type: "stop", enrollmentId: "enrollment-a" });
    expect(
      h.send({ ...enroll, id: "second-enroll", enrollmentId: "second" })
        .decision,
    ).toBe("enrolled-held");
    expect(h.claim().decision).toBe("account-sender-busy");
  });
});

describe("scheduling and completion", () => {
  it("freshness and capability are enforced", () => {
    expect(harness({ capability: false }).claim().decision).toBe(
      "capability-disabled",
    );
    expect(harness().claim(T + 30_001).decision).toBe("stale-evidence");
  });
  it("account-wide caps include manual sends and reservations", () => {
    expect(harness({ invitationCap: 0 }).claim().decision).toBe("daily-cap");
    const h = harness({ messageCap: 1 }, { connection: "Pending" });
    h.observe(
      {
        message: {
          direction: "outgoing",
          at: T + 1,
          attribution: "manual",
          fingerprint: "manual",
        },
      },
      T + 1,
    );
    h.send(
      {
        ...enroll,
        id: "other",
        enrollmentId: "enrollment-b",
        recipientId: "recipient-b",
        at: T + 1,
        receivedAt: T + 1,
        observation: observation(T + 1, { connection: "Pending" }),
      },
      T + 1,
    );
    h.send(
      {
        type: "observe",
        enrollmentId: "enrollment-b",
        observation: observation(T + 2, { connection: "Connected" }),
      },
      T + 2,
    );
    expect(h.claim().decision).toBe("daily-cap");
  });
  it("follow-up due time uses sent time, late receipt never causes a burst", () => {
    const h = harness({}, { connection: "Pending" });
    h.observe({ connection: "Connected" }, T + 1);
    h.claim();
    h.authorize();
    h.dispatch();
    h.outcome("CONFIRMED_SENT", T + 200_000, { at: T + 2 });
    const next = Object.values(h.state.actions).find((a) => a.ordinal === 2)!;
    expect(next.dueAt).toBe(T + 180_002);
    h.observe({ connection: "Connected", connectionAt: T + 1 }, T + 200_001);
    expect(h.claim().decision).toBe("not-due");
  });
  it("zero follow-ups completes and never restarts", () => {
    const h = harness({ followupGapsMs: [] }, { connection: "Pending" });
    h.observe({ connection: "Connected" }, T + 1);
    h.claim();
    h.authorize();
    h.dispatch();
    h.outcome();
    expect(h.enrollment.status).toBe("Completed");
    expect(h.claim().decision).toBe("no-action");
  });
  it("uses explicit timezone with DST and local midnight boundaries", () => {
    expect(
      intlCalendar.local(Date.parse("2026-03-08T06:59:00Z"), "America/New_York")
        .minute,
    ).toBe(119);
    expect(
      intlCalendar.local(Date.parse("2026-03-08T07:00:00Z"), "America/New_York")
        .minute,
    ).toBe(180);
    expect(
      intlCalendar.local(Date.parse("2026-11-01T05:30:00Z"), "America/New_York")
        .minute,
    ).toBe(90);
    expect(
      intlCalendar.local(Date.parse("2026-11-01T06:30:00Z"), "America/New_York")
        .minute,
    ).toBe(90);
    expect(
      intlCalendar.local(Date.parse("2026-10-14T18:30:00Z"), "Asia/Kolkata")
        .day,
    ).toBe("2026-10-15");
    expect(harness({ startMinute: 721, endMinute: 800 }).claim().decision).toBe(
      "working-hours",
    );
  });
  it("timezone changes cannot reset the budget calendar", () => {
    const h = harness({ invitationCap: 1 });
    h.claim();
    h.authorize();
    h.outcome();
    h.send({
      ...configure,
      id: "config-new",
      policy: { ...configure.policy, timezone: "Pacific/Kiritimati" },
    });
    expect(h.state.accounts["account-a"]!.budgetTimezone).toBe("UTC");
    expect(
      h.state.accounts["account-a"]!.budgets.filter((b) => b.state === "spent"),
    ).toHaveLength(1);
  });
});

it("permuted pause/stop/revise/restart sequences never grant a second effect", () => {
  const controls = [
    { type: "stop", enrollmentId: "enrollment-a" },
    { type: "pause", scope: "account", target: "account-a", paused: true },
    { type: "revise", enrollmentId: "enrollment-a", expectedRevision: 1 },
    { type: "restart" },
  ];
  for (const first of controls)
    for (const second of controls) {
      const h = harness();
      h.claim();
      h.authorize();
      h.send(first);
      h.send(second);
      expect(h.dispatch().effects).toHaveLength(0);
      assertInvariants(h.state);
    }
});

describe("regressions and boundary enforcement", () => {
  it("identity mismatch cannot reuse previously fresh evidence", () => {
    const h = harness();
    h.observe({ identityMatches: false }, T + 1);
    expect(h.claim().decision).toBe("identity");
    h.observe({}, T + 2);
    expect(h.claim().decision).toBe("claimed");
  });
  it("late send after revision records history but waits for reapproval to schedule", () => {
    const h = harness({}, { connection: "Pending" });
    h.observe({ connection: "Connected" }, T + 1);
    h.claim();
    h.authorize();
    h.send({
      type: "revise",
      enrollmentId: "enrollment-a",
      expectedRevision: 1,
    });
    h.outcome();
    expect(Object.values(h.state.actions).some((a) => a.ordinal === 2)).toBe(
      false,
    );
    expect(h.enrollment.reason).toBe("approval");
    h.send({
      type: "approve",
      enrollmentId: "enrollment-a",
      revision: 2,
      fieldsComplete: true,
    });
    expect(Object.values(h.state.actions).some((a) => a.ordinal === 2)).toBe(
      true,
    );
  });
  it("own outgoing requires a positively reconciled attempt", () => {
    const h = harness();
    h.claim();
    h.authorize();
    h.outcome();
    h.observe(
      {
        message: {
          direction: "outgoing",
          at: T,
          attribution: "own",
          attemptId: h.attempt.id,
          fingerprint: "own",
        },
      },
      T + 1,
    );
    expect(h.enrollment.status).not.toBe("Stopped");
    h.observe(
      {
        message: {
          direction: "outgoing",
          at: T,
          attribution: "own",
          attemptId: "unrelated",
          fingerprint: "unrelated",
        },
      },
      T + 2,
    );
    expect(h.enrollment.reason).toBe("ambiguous-message");
  });
  it("conflicting event IDs hold, while cross-workspace writes leave state unchanged", () => {
    const h = harness();
    const before = structuredClone(h.state);
    expect(
      h.send({
        type: "stop",
        workspaceId: "other-workspace",
        enrollmentId: "enrollment-a",
      }).decision,
    ).toBe("workspace-mismatch");
    expect(h.state).toEqual(before);
    h.send({ id: "fixed", type: "quota", available: true });
    expect(
      h.send({ id: "fixed", type: "quota", available: false }).decision,
    ).toBe("conflicting-event");
    expect(h.claim().decision).toBe("paused");
  });
  it("working window is start-inclusive and end-exclusive", () => {
    expect(harness({ startMinute: 720, endMinute: 721 }).claim().decision).toBe(
      "claimed",
    );
    expect(harness({ startMinute: 719, endMinute: 720 }).claim().decision).toBe(
      "working-hours",
    );
  });
  it("expired authorization is not permission to redispatch", () => {
    const h = harness();
    h.claim();
    h.authorize();
    expect(h.dispatch(T + 10_000).decision).toBe("expired-authority");
    expect(h.claim().decision).toBe("account-sender-busy");
  });
  it("completed daily sends reset only on the fixed budget calendar next day", () => {
    const h = harness({ invitationCap: 1, spacingMs: 0 });
    h.claim();
    h.authorize();
    h.outcome();
    h.send({ ...enroll, id: "enroll-b", enrollmentId: "b", recipientId: "b" });
    expect(h.claim().decision).toBe("daily-cap");
    h.send(
      {
        type: "observe",
        enrollmentId: "b",
        observation: observation(T + 86_400_000),
      },
      T + 86_400_000,
    );
    expect(h.claim().decision).toBe("claimed");
  });
  it("overdue work is spaced and equal due times use stable action IDs", () => {
    const h = harness();
    h.send({ ...enroll, id: "enroll-b", enrollmentId: "b", recipientId: "b" });
    const expected = Object.values(h.state.actions).sort((a, b) =>
      a.id.localeCompare(b.id),
    )[0]!;
    h.claim();
    expect(h.attempt.actionId).toBe(expected.id);
    h.authorize();
    h.dispatch();
    h.outcome();
    expect(h.claim().decision).toBe("not-due");
  });
  it("up to three configured follow-ups complete only after the last confirmation", () => {
    const h = harness(
      { followupGapsMs: [0, 0, 0], spacingMs: 0 },
      { connection: "Pending" },
    );
    h.observe({ connection: "Connected" }, T + 1);
    for (let i = 0; i < 4; i++) {
      expect(h.claim().decision).toBe("claimed");
      h.authorize();
      h.dispatch();
      h.outcome();
      if (i < 3) expect(h.enrollment.status).not.toBe("Completed");
    }
    expect(h.enrollment.status).toBe("Completed");
    expect(
      Object.values(h.state.actions).filter(
        (a) => a.status === "ConfirmedSent",
      ),
    ).toHaveLength(4);
  });
});

it("fresh unrelated observations do not clear unknown send state", () => {
  const h = harness();
  h.claim();
  h.authorize();
  h.outcome("OUTCOME_UNKNOWN");
  h.observe({}, T + 1);
  expect(h.enrollment.status).toBe("Held");
  expect(h.claim().decision).toBe("account-sender-busy");
});
it("conflicting confirmation times remain held", () => {
  const h = harness();
  h.claim();
  h.authorize();
  h.outcome();
  expect(h.outcome("CONFIRMED_SENT", T + 1).decision).toBe(
    "conflicting-outcome",
  );
});
it("timezone edits do not evade a consumed invitation cap", () => {
  const h = harness({ invitationCap: 1 });
  h.claim();
  h.authorize();
  h.outcome();
  h.send({
    ...configure,
    id: "new-policy",
    policy: {
      ...configure.policy,
      invitationCap: 1,
      timezone: "Pacific/Kiritimati",
    },
  });
  h.send(
    {
      ...enroll,
      id: "other-enrollment",
      enrollmentId: "other",
      recipientId: "other",
      at: T + 120_000,
      receivedAt: T + 120_000,
      observation: observation(T + 120_000),
    },
    T + 120_000,
  );
  expect(h.claim().decision).toBe("daily-cap");
});
it("repeated DST hour does not reset the account day budget", () => {
  const h = harness({
    timezone: "America/New_York",
    weekdays: [0],
    startMinute: 60,
    endMinute: 120,
    invitationCap: 1,
  });
  const first = Date.parse("2026-11-01T05:30:00Z"),
    second = Date.parse("2026-11-01T06:30:00Z");
  h.observe({}, first);
  expect(h.claim().decision).toBe("claimed");
  h.authorize();
  h.dispatch();
  h.outcome();
  h.send(
    {
      ...enroll,
      id: "fall-back",
      enrollmentId: "other",
      recipientId: "other",
      at: second,
      receivedAt: second,
      observation: observation(second),
    },
    second,
  );
  expect(h.claim().decision).toBe("daily-cap");
});

it("reapproval honors increased gaps and cancels removed future steps", () => {
  const h = harness({ spacingMs: 0 }, { connection: "Pending" });
  h.observe({ connection: "Connected" }, T + 1);
  h.claim();
  h.authorize();
  h.outcome();
  h.send({
    ...configure,
    id: "gap-edit",
    at: T + 1,
    receivedAt: T + 1,
    policy: { ...configure.policy, followupGapsMs: [600_000] },
  });
  h.send({
    type: "approve",
    enrollmentId: "enrollment-a",
    revision: 2,
    fieldsComplete: true,
  });
  expect(
    Object.values(h.state.actions).find((a) => a.ordinal === 2)?.dueAt,
  ).toBe(T + 600_001);
  h.send({
    ...configure,
    id: "remove-step",
    at: T + 1,
    receivedAt: T + 1,
    policy: { ...configure.policy, followupGapsMs: [] },
  });
  h.send({
    type: "approve",
    enrollmentId: "enrollment-a",
    revision: 3,
    fieldsComplete: true,
  });
  expect(
    Object.values(h.state.actions).find((a) => a.ordinal === 2)?.status,
  ).toBe("Cancelled");
  expect(h.enrollment.status).toBe("Completed");
});

describe("confirmed rejection", () => {
  it("stops at baseline without any planned outreach", () => {
    const h = harness({}, { connection: "RejectedConfirmed" });
    expect(h.enrollment.status).toBe("Stopped");
    expect(h.enrollment.reason).toBe("rejection");
    expect(h.claim().decision).toBe("no-action");
  });
  it("stops pending and never restarts after later acceptance", () => {
    const h = harness({}, { connection: "Pending" });
    h.observe({ connection: "RejectedConfirmed" }, T + 1);
    expect(h.enrollment.reason).toBe("rejection");
    h.observe({ connection: "Connected" }, T + 2);
    expect(h.enrollment.status).toBe("Stopped");
    expect(h.claim().decision).toBe("no-action");
  });
  it("cancels follow-ups while preserving confirmed history", () => {
    const h = harness({}, { connection: "Pending" });
    h.observe({ connection: "Connected" }, T + 1);
    h.claim();
    h.authorize();
    h.dispatch();
    h.outcome();
    h.observe({ connection: "RejectedConfirmed" }, T + 2);
    expect(
      Object.values(h.state.actions).find((a) => a.ordinal === 1)?.status,
    ).toBe("ConfirmedSent");
    expect(
      Object.values(h.state.actions).find((a) => a.ordinal === 2)?.status,
    ).toBe("Cancelled");
    expect(h.enrollment.reason).toBe("rejection");
  });
  it("holds possible sends and records late results without advancing", () => {
    const h = harness();
    h.claim();
    h.authorize();
    h.observe({ connection: "RejectedConfirmed" }, T + 1);
    expect(h.attempt.phase).toBe("unknown");
    h.outcome("CONFIRMED_SENT", T + 2);
    expect(h.enrollment.status).toBe("Stopped");
    expect(Object.values(h.state.actions)).toHaveLength(1);
    expect(h.claim().decision).toBe("no-action");
  });
  it("does not turn pending or absence into rejection", () => {
    const h = harness({}, { connection: "Pending" });
    expect(h.enrollment.status).toBe("Waiting");
    h.observe({ connection: "Unknown", complete: false }, T + 1);
    expect(h.enrollment.status).toBe("Held");
    expect(h.enrollment.reason).not.toBe("rejection");
  });
  it("does not trust mismatched or older rejection observations", () => {
    const h = harness();
    h.observe(
      { identityMatches: false, connection: "RejectedConfirmed" },
      T + 1,
    );
    expect(h.enrollment.status).toBe("Held");
    expect(h.enrollment.reason).toBe("identity");
    h.observe({ connection: "Pending" }, T + 2);
    h.observe(
      {
        connection: "RejectedConfirmed",
        observedAt: T + 1,
        connectionAt: T + 1,
        coverageTo: T + 1,
      },
      T + 3,
    );
    expect(h.enrollment.status).toBe("Waiting");
    expect(h.enrollment.connection).toBe("Pending");
  });
});
