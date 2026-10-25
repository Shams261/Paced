import type {
  Account,
  Attempt,
  Context,
  Enrollment,
  SimulationState,
} from "./contracts.js";
export function initialState(): SimulationState {
  return {
    accounts: {},
    enrollments: {},
    actions: {},
    attempts: {},
    campaignPauses: [],
    personPauses: [],
    events: {},
    results: {},
    history: [],
    conflicts: [],
    clock: 0,
  };
}
export const terminal = (e: Enrollment) =>
  e.status === "Stopped" || e.status === "Completed";
export const pending = (a: Attempt) =>
  ["claimed", "possible", "unknown"].includes(a.phase) || a.conflict;
export const key = (...parts: string[]) => JSON.stringify(parts);
// Canonical keys make duplicate detection independent of object insertion order.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function get<T>(map: Record<string, T>, id: string): T | undefined {
  return Object.hasOwn(map, id) ? map[id] : undefined;
}
export function put<T>(map: Record<string, T>, id: string, value: T): void {
  Object.defineProperty(map, id, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}
export function hold(e: Enrollment, reason: string): void {
  if (!terminal(e)) {
    e.status = "Held";
    e.reason = reason;
  }
}
export function stop(s: SimulationState, e: Enrollment, reason: string): void {
  if (!terminal(e)) {
    e.status = "Stopped";
    e.reason = reason;
  }
  for (const a of Object.values(s.actions).filter(
    (a) => a.enrollmentId === e.id,
  )) {
    if (
      !["ConfirmedSent", "Skipped", "MayHaveSent", "OutcomeUnknown"].includes(
        a.status,
      )
    )
      a.status = "Cancelled";
  }
}
export function paused(s: SimulationState, e: Enrollment, a: Account): boolean {
  return (
    a.paused ||
    s.campaignPauses.includes(key(e.accountId, e.campaignId)) ||
    s.personPauses.includes(key(e.accountId, e.id))
  );
}
export function relevantAttempts(
  s: SimulationState,
  accountId: string,
): Attempt[] {
  return Object.values(s.attempts).filter(
    (a) => a.accountId === accountId && pending(a),
  );
}
export function addAction(
  s: SimulationState,
  e: Enrollment,
  ordinal: number,
  dueAt: number,
  c: Context,
): void {
  const id = c.id("action", key(e.id, String(ordinal)));
  if (get(s.actions, id)) return;
  put(s.actions, id, {
    id,
    enrollmentId: e.id,
    ordinal,
    kind: ordinal === 0 ? "invitation" : "message",
    status: "Planned",
    dueAt,
    confirmedAt: null,
  });
}
export function advance(s: SimulationState, e: Enrollment, c: Context): void {
  if (terminal(e)) return;
  if (e.approvedRevision !== e.revision) {
    hold(e, "approval");
    return;
  }
  const actions = Object.values(s.actions).filter(
    (a) => a.enrollmentId === e.id,
  );
  const last = actions
    .filter((a) => a.status === "ConfirmedSent")
    .sort((a, b) => b.ordinal - a.ordinal)[0];
  if (!last || last.kind === "invitation") {
    if (e.connection === "Connected" && e.connectionAt > e.enrolledAt)
      addAction(s, e, 1, e.connectionAt + e.firstDelay, c);
    return;
  }
  if (last.ordinal <= e.gaps.length) {
    addAction(
      s,
      e,
      last.ordinal + 1,
      last.confirmedAt! + e.gaps[last.ordinal - 1]!,
      c,
    );
    e.status = "Active";
    e.reason = "next-step";
  } else {
    e.status = "Completed";
    e.reason = "final-step";
  }
}
export function release(s: SimulationState, t: Attempt, now: number): void {
  t.phase = "not-sent";
  const a = s.accounts[t.accountId]!;
  const b = a.budgets.find((b) => b.id === t.id);
  if (b) b.state = "released";
  const act = s.actions[t.actionId]!;
  const e = s.enrollments[act.enrollmentId]!;
  if (!terminal(e)) {
    act.status = "NotSent";
    act.dueAt = Math.max(act.dueAt, now + a.policy.retryMs);
  }
}
export function fenceUnused(
  s: SimulationState,
  accountId: string,
  now: number,
): void {
  for (const t of relevantAttempts(s, accountId)) {
    if (t.phase === "claimed") release(s, t, now);
    else {
      t.phase = "unknown";
      s.actions[t.actionId]!.status = "OutcomeUnknown";
      hold(
        s.enrollments[s.actions[t.actionId]!.enrollmentId]!,
        "outcome-unknown",
      );
    }
  }
}
