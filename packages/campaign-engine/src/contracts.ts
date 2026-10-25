import { z } from "zod";

const id = z.string().min(1).max(100);
const time = z.number().int().nonnegative().max(8_640_000_000_000_000);
const duration = z.number().int().nonnegative().max(31_536_000_000);
export const policySchema = z
  .strictObject({
    timezone: z.string().min(1),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1),
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(1).max(1440),
    invitationCap: z.number().int().nonnegative(),
    messageCap: z.number().int().nonnegative(),
    spacingMs: duration,
    firstMessageDelayMs: duration,
    followupGapsMs: z.array(duration).max(3),
    freshnessMs: duration,
    leaseMs: duration.positive(),
    authorizationMs: duration.positive(),
    retryMs: duration,
    capability: z.boolean(),
  })
  .refine(
    (p) => p.endMinute > p.startMinute,
    "Working window must end after it starts",
  );
export type Policy = z.infer<typeof policySchema>;
export const connectionSchema = z.enum([
  "Unknown",
  "NotConnected",
  "Pending",
  "Connected",
  "WithdrawnConfirmed",
  "RejectedConfirmed",
]);
export const observationSchema = z.strictObject({
  source: z.literal("SYN"),
  identityMatches: z.boolean(),
  connection: connectionSchema,
  observedAt: time,
  connectionAt: time,
  coverageFrom: time,
  coverageTo: time,
  complete: z.boolean(),
  noteAllowed: z.boolean(),
  message: z
    .strictObject({
      direction: z.enum(["incoming", "outgoing"]),
      at: time.nullable(),
      attribution: z.enum(["manual", "own", "unknown"]),
      attemptId: id.optional(),
      fingerprint: id,
    })
    .optional(),
});
export type Observation = z.infer<typeof observationSchema>;
const base = {
  version: z.literal(1),
  id,
  workspaceId: id,
  accountId: id,
  at: time,
  receivedAt: time,
};
export const eventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...base,
    type: z.literal("configure"),
    policy: policySchema,
  }),
  z.strictObject({
    ...base,
    type: z.literal("enroll"),
    enrollmentId: id,
    recipientId: id,
    campaignId: id,
    revision: z.number().int().positive(),
    approved: z.boolean(),
    fieldsComplete: z.boolean(),
    note: z.boolean(),
    observation: observationSchema,
  }),
  z.strictObject({
    ...base,
    type: z.literal("observe"),
    enrollmentId: id,
    observation: observationSchema,
  }),
  z.strictObject({
    ...base,
    type: z.literal("revise"),
    enrollmentId: id,
    expectedRevision: z.number().int().positive(),
  }),
  z.strictObject({
    ...base,
    type: z.literal("approve"),
    enrollmentId: id,
    revision: z.number().int().positive(),
    fieldsComplete: z.boolean(),
  }),
  z.strictObject({
    ...base,
    type: z.literal("pause"),
    scope: z.enum(["account", "campaign", "person"]),
    target: id,
    paused: z.boolean(),
  }),
  z.strictObject({ ...base, type: z.literal("stop"), enrollmentId: id }),
  z.strictObject({ ...base, type: z.literal("claim"), executorId: id }),
  z.strictObject({
    ...base,
    type: z.literal("authorize"),
    attemptId: id,
    executorId: id,
    token: z.number().int().positive(),
    revision: z.number().int().positive(),
    identityMatches: z.boolean(),
  }),
  z.strictObject({
    ...base,
    type: z.literal("may-have-sent"),
    attemptId: id,
    executorId: id,
    token: z.number().int().positive(),
  }),
  z.strictObject({
    ...base,
    type: z.literal("outcome"),
    attemptId: id,
    resultId: id,
    outcome: z.enum(["CONFIRMED_SENT", "NOT_SENT", "OUTCOME_UNKNOWN"]),
    positiveEvidence: z.boolean(),
  }),
  z.strictObject({
    ...base,
    type: z.literal("reconcile"),
    attemptId: id,
    resultId: id,
    outcome: z.enum(["CONFIRMED_SENT", "NOT_SENT"]),
    positiveEvidence: z.literal(true),
  }),
  z.strictObject({ ...base, type: z.literal("revoke"), executorId: id }),
  z.strictObject({ ...base, type: z.literal("restart") }),
  z.strictObject({ ...base, type: z.literal("restore") }),
  z.strictObject({ ...base, type: z.literal("restore-reconciled") }),
  z.strictObject({ ...base, type: z.literal("quota"), available: z.boolean() }),
]);
export type SimulationEvent = z.infer<typeof eventSchema>;
export type Connection = z.infer<typeof connectionSchema>;
export type EnrollmentStatus =
  "Active" | "Waiting" | "Paused" | "Held" | "Stopped" | "Completed";
export type ActionStatus =
  | "Planned"
  | "Claimed"
  | "Authorized"
  | "MayHaveSent"
  | "ConfirmedSent"
  | "NotSent"
  | "OutcomeUnknown"
  | "Cancelled"
  | "Skipped";
export interface Action {
  id: string;
  enrollmentId: string;
  ordinal: number;
  kind: "invitation" | "message";
  status: ActionStatus;
  dueAt: number;
  confirmedAt: number | null;
}
export interface Enrollment {
  id: string;
  accountId: string;
  recipientId: string;
  campaignId: string;
  enrolledAt: number;
  status: EnrollmentStatus;
  reason: string;
  connection: Connection;
  connectionAt: number;
  observation: Observation;
  revision: number;
  approvedRevision: number | null;
  fieldsComplete: boolean;
  note: boolean;
  gaps: number[];
  firstDelay: number;
  restored: boolean;
}
export interface ExecutionLease {
  executorId: string;
  token: number;
  expiresAt: number;
}
export interface Attempt {
  id: string;
  actionId: string;
  accountId: string;
  revision: number;
  lease: ExecutionLease;
  phase: "claimed" | "possible" | "unknown" | "sent" | "not-sent";
  authorizedAt: number | null;
  dispatched: boolean;
  conflict: boolean;
}
export interface BudgetEntry {
  id: string;
  kind: "invitation" | "message";
  at: number;
  state: "reserved" | "spent" | "released";
}
export interface Account {
  workspaceId: string;
  policy: Policy;
  budgetTimezone: string;
  paused: boolean;
  quota: boolean;
  restored: boolean;
  revoked: string[];
  token: number;
  nextAt: number;
  budgets: BudgetEntry[];
}
export interface SimulationState {
  accounts: Record<string, Account>;
  enrollments: Record<string, Enrollment>;
  actions: Record<string, Action>;
  attempts: Record<string, Attempt>;
  campaignPauses: string[];
  personPauses: string[];
  events: Record<string, string>;
  results: Record<string, string>;
  history: SimulationEvent[];
  conflicts: SimulationEvent[];
  clock: number;
}
export interface Calendar {
  local(
    instant: number,
    timezone: string,
  ): { day: string; weekday: number; minute: number };
}
export interface Context {
  now: number;
  calendar: Calendar;
  id: (kind: "action" | "attempt", seed: string) => string;
}
export interface ActionCommand {
  version: 1;
  source: "SYN";
  workspaceId: string;
  accountId: string;
  recipientId: string;
  enrollmentId: string;
  actionId: string;
  attemptId: string;
  approvedRevision: number;
  fencingToken: number;
  expiresAt: number;
  kind: "invitation" | "message";
}
export type AttemptResult = Extract<
  SimulationEvent,
  { type: "outcome" | "reconcile" }
>;
export interface SimulatedEffect {
  type: "SIMULATED_SEND";
  command: ActionCommand;
  actionId: string;
  attemptId: string;
}
export interface TransitionResult {
  state: SimulationState;
  decision: string;
  effects: SimulatedEffect[];
}
