import {
  initialState,
  intlCalendar,
  runScenario,
  type Observation,
  type Policy,
  type SimulationEvent,
} from "@outreach/campaign-engine";
export const T = Date.parse("2026-10-14T12:00:00Z");
export const fixturePolicy: Policy = {
  timezone: "UTC",
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  startMinute: 0,
  endMinute: 1440,
  invitationCap: 10,
  messageCap: 20,
  spacingMs: 120_000,
  firstMessageDelayMs: 0,
  followupGapsMs: [180_000],
  freshnessMs: 30_000,
  leaseMs: 60_000,
  authorizationMs: 10_000,
  retryMs: 1000,
  capability: true,
};
export const provisionalPolicy: Policy = {
  ...fixturePolicy,
  weekdays: [1, 2, 3, 4, 5],
  startMinute: 540,
  endMinute: 1020,
  firstMessageDelayMs: 86_400_000,
  followupGapsMs: [259_200_000, 259_200_000, 259_200_000],
};
export const context = {
  calendar: intlCalendar,
  id: (kind: "action" | "attempt", seed: string) => `${kind}:${seed}`,
};
export function observation(
  at = T,
  patch: Partial<Observation> = {},
): Observation {
  return {
    source: "SYN",
    identityMatches: true,
    connection: "NotConnected",
    observedAt: at,
    connectionAt: at,
    coverageFrom: T,
    coverageTo: at,
    complete: true,
    noteAllowed: true,
    ...patch,
  };
}
export const configure: Extract<SimulationEvent, { type: "configure" }> = {
  version: 1,
  id: "config",
  workspaceId: "workspace-a",
  accountId: "account-a",
  at: T,
  receivedAt: T,
  type: "configure",
  policy: fixturePolicy,
};
export const enroll: Extract<SimulationEvent, { type: "enroll" }> = {
  version: 1,
  id: "enroll",
  workspaceId: "workspace-a",
  accountId: "account-a",
  at: T,
  receivedAt: T,
  type: "enroll",
  enrollmentId: "enrollment-a",
  recipientId: "recipient-a",
  campaignId: "campaign-a",
  revision: 1,
  approved: true,
  fieldsComplete: true,
  note: true,
  observation: observation(),
};
export function event(
  id: string,
  at: number,
  payload: Record<string, unknown>,
): SimulationEvent {
  // Fixtures go through the runtime parser too; casting is confined to synthetic construction.
  return {
    version: 1,
    id,
    workspaceId: "workspace-a",
    accountId: "account-a",
    at,
    receivedAt: at,
    ...payload,
  } as SimulationEvent;
}
const pending = {
  ...enroll,
  observation: observation(T, { connection: "Pending" }),
};
export const scenarios: Record<
  string,
  {
    description: string;
    events: SimulationEvent[];
    expectedLastDecision: string;
  }
> = {
  "confirmed-rejection": {
    description:
      "SYN: confirmed rejection stops the sequence; pending or missing evidence is not rejection.",
    events: [
      configure,
      pending,
      event("rejection", T + 1000, {
        type: "observe",
        enrollmentId: "enrollment-a",
        observation: observation(T + 1000, { connection: "RejectedConfirmed" }),
      }),
      event("claim-after-rejection", T + 1000, {
        type: "claim",
        executorId: "executor-a",
      }),
    ],
    expectedLastDecision: "no-action",
  },
  "pending-reply": {
    description: "SYN: reply before acceptance cancels the waiting sequence.",
    events: [
      configure,
      pending,
      event("reply", T + 1000, {
        type: "observe",
        enrollmentId: "enrollment-a",
        observation: observation(T + 1000, {
          connection: "Pending",
          message: {
            direction: "incoming",
            at: T + 500,
            attribution: "unknown",
            fingerprint: "message-1",
          },
        }),
      }),
      event("claim", T + 1000, { type: "claim", executorId: "executor-a" }),
    ],
    expectedLastDecision: "no-action",
  },
  "unknown-restart": {
    description:
      "SYN: authorization lost across restart cannot be redispatched.",
    events: [
      configure,
      enroll,
      event("claim", T, { type: "claim", executorId: "executor-a" }),
      event("authorize", T, {
        type: "authorize",
        attemptId: "attempt:claim",
        executorId: "executor-a",
        token: 1,
        revision: 1,
        identityMatches: true,
      }),
      event("restart", T + 70_000, { type: "restart" }),
      event("second-claim", T + 70_000, {
        type: "claim",
        executorId: "executor-b",
      }),
    ],
    expectedLastDecision: "account-sender-busy",
  },
  "acceptance-message": {
    description:
      "SYN: pending invitation accepted, first message confirmed, follow-up planned.",
    events: [
      configure,
      pending,
      event("accept", T + 1000, {
        type: "observe",
        enrollmentId: "enrollment-a",
        observation: observation(T + 1000, { connection: "Connected" }),
      }),
      event("claim", T + 1000, { type: "claim", executorId: "executor-a" }),
      event("authorize", T + 1000, {
        type: "authorize",
        attemptId: "attempt:claim",
        executorId: "executor-a",
        token: 1,
        revision: 1,
        identityMatches: true,
      }),
      event("dispatch", T + 1000, {
        type: "may-have-sent",
        attemptId: "attempt:claim",
        executorId: "executor-a",
        token: 1,
      }),
      event("result", T + 2000, {
        type: "outcome",
        attemptId: "attempt:claim",
        resultId: "result-a",
        outcome: "CONFIRMED_SENT",
        positiveEvidence: true,
      }),
    ],
    expectedLastDecision: "confirmed-sent",
  },
  "provisional-defaults": {
    description:
      "SYN: provisional architecture defaults remain injected; acceptance does not bypass first-message delay.",
    events: [
      { ...configure, policy: provisionalPolicy },
      pending,
      event("accept", T + 1000, {
        type: "observe",
        enrollmentId: "enrollment-a",
        observation: observation(T + 1000, { connection: "Connected" }),
      }),
      event("claim", T + 1000, { type: "claim", executorId: "executor-a" }),
    ],
    expectedLastDecision: "not-due",
  },
};
export function simulate(name: string) {
  const scenario = scenarios[name];
  if (!scenario) throw new Error(`Unknown scenario: ${name}`);
  return runScenario(initialState(), scenario.events, context);
}
