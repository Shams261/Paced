import { useEffect, useRef, useState } from "react";
import type {
  ExecutionMode,
  QueueEvent,
  QueueItem,
  QueuePerson,
  QueueRequest,
  QueueView,
} from "../../../packages/shell-contracts/src/management";
/**
 * The manual send queue. The user performs every LinkedIn action by hand; this section says which
 * approved step is due for whom, holds the account while one step is open, and records the user's answer.
 */
const BLOCKED: Record<string, string> = {
  busy: "answer the open step first",
  "campaign-paused": "campaign paused",
  "connection-unknown": "connection state unknown; report it below",
  "already-pending": "invitation already pending",
  "already-connected": "already connected; report it below",
  "awaiting-acceptance": "waiting for acceptance",
  "not-due": "not due yet",
  "daily-cap": "daily limit reached",
  spacing: "wait for the spacing interval",
};
const EVENTS: { event: QueueEvent; label: string }[] = [
  { event: "accepted", label: "Accepted" },
  { event: "replied", label: "Replied" },
  { event: "messaged", label: "Messaged by hand" },
  { event: "withdrawn", label: "Withdrawn" },
  { event: "declined", label: "Declined" },
  { event: "already-connected", label: "Already connected" },
  { event: "not-connected", label: "Not connected" },
];
export function stepLabel(step: number, text: string): string {
  if (step === 0)
    return text ? "Invitation with note" : "Invitation without note";
  if (step === 1) return "First message";
  return `Follow-up ${step - 1}`;
}
function reportsFor(person: QueuePerson): QueueEvent[] {
  if (person.status === "Waiting")
    return ["accepted", "declined", "withdrawn", "replied"];
  const events: QueueEvent[] = ["replied", "messaged"];
  if (person.connection !== "Connected") events.push("already-connected");
  if (person.connection === "Unknown") events.push("not-connected");
  return events;
}
function reportLabel(report: NonNullable<QueuePerson["lastReport"]>): string {
  if (report.messageDirection === "incoming") return "replied";
  if (report.messageDirection === "outgoing") return "messaged by hand";
  return (
    {
      Connected: "connected",
      Pending: "invitation sent",
      NotConnected: "not connected",
      WithdrawnConfirmed: "withdrawn",
      RejectedConfirmed: "declined",
    }[report.connection] ?? report.connection
  );
}
export function SendByHand({
  csrfToken,
  mode,
  reloadKey = 0,
  onAccessLost,
  onChanged,
}: {
  csrfToken: string;
  mode: ExecutionMode;
  /** Changes whenever the saved records were reloaded, so a new approval shows up in the queue. */
  reloadKey?: number;
  onAccessLost: () => void;
  onChanged: () => void;
}) {
  const [view, setView] = useState<QueueView | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);
  const alive = useRef(true);
  async function call(body?: QueueRequest): Promise<QueueView> {
    const response = await fetch("/api/v1/queue", {
      method: body ? "POST" : "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
      ...(body
        ? {
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": csrfToken,
            },
            body: JSON.stringify(body),
          }
        : {}),
    });
    if (body && (response.status === 401 || response.status === 403)) {
      const error = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (error?.error !== "CSRF_DENIED") onAccessLost();
      throw new Error(error?.error ?? "ACCESS_DENIED");
    }
    if (!response.ok) {
      const error = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new Error(error?.error ?? "UNAVAILABLE");
    }
    const next = (await response.json()) as Partial<QueueView> | null;
    if (!next || !Array.isArray(next.items) || !Array.isArray(next.people))
      throw new Error("INVALID");
    return next as QueueView;
  }
  async function load() {
    try {
      const next = await call();
      if (alive.current) setView(next);
    } catch {
      if (alive.current) setView(null);
    }
  }
  async function run(body: QueueRequest, done: string) {
    if (busy) return;
    setBusy(true);
    setNotice("");
    setCopied(false);
    try {
      const next = await call(body);
      if (!alive.current) return;
      setView(next);
      setNotice(done);
      onChanged();
    } catch (error) {
      if (!alive.current) return;
      const code = error instanceof Error ? error.message : "";
      setNotice(
        code === "QUEUE_BLOCKED"
          ? "That step cannot start right now. The list was refreshed."
          : code === "REVISION_OR_REQUEST_CONFLICT"
            ? "That sequence has already ended. The list was refreshed."
            : code === "INVALID_MANAGEMENT_REQUEST"
              ? "Not saved: the server did not accept this request."
              : "Not saved: the queue is unavailable. Retry shortly.",
      );
      await load();
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [mode, reloadKey]);
  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
      setNotice("Copy failed; select the text and copy it yourself.");
    }
  }
  const current = view?.current ?? null;
  const items: QueueItem[] = view?.items ?? [];
  const people: QueuePerson[] = view?.people ?? [];
  return (
    <section aria-label="Send by hand">
      <h3>Send by hand</h3>
      <p>
        Paced sends nothing. It shows which approved step is due for whom; you
        open the person's page, send the text yourself, and answer here. Manual
        sending is <strong>{mode === "manual" ? "on" : "off"}</strong>.
      </p>
      {notice && <p role="status">{notice}</p>}
      {view ? (
        <p>
          Today: {view.invitationsToday} of {view.invitationCap} invitations,{" "}
          {view.messagesToday} of {view.messageCap} messages. Spacing{" "}
          {view.spacingMinutes} minutes between starts
          {view.nextAllowedAt && new Date(view.nextAllowedAt) > new Date()
            ? `; next start allowed at ${new Date(view.nextAllowedAt).toLocaleTimeString()}`
            : ""}
          .
        </p>
      ) : (
        <p>Queue not loaded.</p>
      )}
      {current && (
        <div role="group" aria-label="Open step">
          <p>
            <strong>{current.displayName}</strong>:{" "}
            {stepLabel(current.step, current.text)}, started{" "}
            {new Date(current.startedAt).toLocaleTimeString()}. Send this text
            by hand, then answer. Nothing else can start until you do.
          </p>
          <textarea
            aria-label="Text to send"
            readOnly
            rows={4}
            value={current.text}
          />
          <button disabled={busy} onClick={() => void copyText(current.text)}>
            {copied ? "Copied" : "Copy text"}
          </button>
          {current.profilePath && (
            <a
              href={`https://www.linkedin.com${current.profilePath}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open {current.displayName}'s profile
            </a>
          )}
          <button
            disabled={busy}
            onClick={() =>
              void run(
                { operation: "sent", attemptId: current.attemptId },
                "Recorded as sent, reported by you.",
              )
            }
          >
            I sent it
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void run(
                { operation: "not-sent", attemptId: current.attemptId },
                "Recorded as not sent. The step returns to the queue.",
              )
            }
          >
            I did not send it
          </button>
        </div>
      )}
      <h4>Due steps</h4>
      {items.length === 0 ? (
        <p>Nothing is due.</p>
      ) : (
        <ul aria-label="Due steps">
          {items.map((item) => (
            <li key={item.actionId}>
              <strong>{item.displayName}</strong> — {item.campaignName} —{" "}
              {stepLabel(item.step, item.text)} — due{" "}
              {new Date(item.dueAt).toLocaleString()}
              {item.blocked ? (
                <> — {BLOCKED[item.blocked] ?? item.blocked}</>
              ) : (
                <button
                  disabled={busy || mode !== "manual" || !!current}
                  onClick={() =>
                    void run(
                      { operation: "start", actionId: item.actionId },
                      "Step started. Send it by hand, then answer.",
                    )
                  }
                >
                  Start {item.displayName}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <h4>People in sequences</h4>
      {people.length === 0 ? (
        <p>No one is in a sequence.</p>
      ) : (
        <ul aria-label="People in sequences">
          {people.map((person) => (
            <li key={person.enrollmentId}>
              <strong>{person.displayName}</strong> — {person.campaignName} —{" "}
              {person.status}
              {person.stopReason ? ` (${person.stopReason})` : ""} —{" "}
              {person.connection}
              {person.lastReport
                ? ` — ${reportLabel(person.lastReport)}, reported by you ${new Date(person.lastReport.at).toLocaleString()}`
                : ""}
              {person.lastObserved
                ? ` — seen ${person.lastObserved.connection} by your browser ${new Date(person.lastObserved.at).toLocaleString()}`
                : ""}
              {person.profilePath && (
                <>
                  {" "}
                  <a
                    href={`https://www.linkedin.com${person.profilePath}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    profile
                  </a>
                </>
              )}
              {reportsFor(person).map((event) => (
                <button
                  key={event}
                  disabled={busy || !!current}
                  onClick={() =>
                    void run(
                      {
                        operation: "report",
                        enrollmentId: person.enrollmentId,
                        event,
                      },
                      "Recorded, reported by you.",
                    )
                  }
                >
                  {EVENTS.find((e) => e.event === event)!.label}:{" "}
                  {person.displayName}
                </button>
              ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
