import { visibleText, type ParseOptions } from "./parse.js";
/** One message in a thread as evidence: who sent it (relative to the signed-in user), when, and a stable fingerprint. Never the text. */
export interface ThreadMessage {
  direction: "incoming" | "outgoing";
  at: Date;
  /** Stable per message: the page's own event identifier. */
  eventId: string;
}
export interface ThreadObservation {
  messages: ThreadMessage[];
  /** True when the newest message is rendered and nothing older is still loading. */
  complete: boolean;
  /** Messages that could not be placed in time or attributed to a sender; they are not reported. */
  skipped: number;
}
const monthNames = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const weekdays = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];
/** Date headings are relative ("Today", "Tuesday") or short ("Nov 3", "Nov 3, 2025"); resolved against the clock given. */
export function dateFromHeading(text: string, now: Date): Date | null {
  const t = text.trim().toLowerCase();
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (t === "today") return day;
  if (t === "yesterday") return new Date(day.getTime() - 86_400_000);
  const weekday = weekdays.indexOf(t);
  if (weekday >= 0) {
    const back = (day.getDay() - weekday + 7) % 7 || 7;
    return new Date(day.getTime() - back * 86_400_000);
  }
  const m = /^([a-z]{3})[a-z]*\s+(\d{1,2})(?:,\s*(\d{4}))?$/.exec(t);
  if (!m) return null;
  const month = monthNames.indexOf(m[1]!);
  if (month < 0) return null;
  const year = m[3] ? Number(m[3]) : now.getFullYear();
  const date = new Date(year, month, Number(m[2]));
  // A month-day heading without a year that lies ahead of today belongs to last year.
  if (!m[3] && date.getTime() > day.getTime())
    date.setFullYear(date.getFullYear() - 1);
  return date;
}
export function timeOfDay(
  text: string,
): { hours: number; minutes: number } | null {
  const m = /^(\d{1,2}):(\d{2})\s*([ap]m)?$/i.exec(text.trim());
  if (!m) return null;
  let hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (m[3]) {
    const pm = m[3].toLowerCase() === "pm";
    if (hours === 12) hours = pm ? 12 : 0;
    else if (pm) hours += 12;
  }
  if (hours > 23 || minutes > 59) return null;
  return { hours, minutes };
}
/**
 * Reads the open thread. Direction is decided by comparing the sender's visible name with the
 * signed-in user's name; without that name no message is reported and the observation is incomplete.
 */
export function parseThread(
  root: ParentNode,
  options: ParseOptions,
  selfName: string | null,
  now = new Date(),
): ThreadObservation {
  const list = root.querySelector(".msg-s-message-list-content");
  if (!list) return { messages: [], complete: false, skipped: 0 };
  const items = Array.from(list.querySelectorAll(":scope > li"));
  const loading = items.some(
    (li) =>
      li.classList.contains("msg-s-message-list__loader") &&
      options.isVisible(li),
  );
  const hasBottom = items.some((li) =>
    li.classList.contains("msg-s-message-list__bottom-of-list"),
  );
  let heading: Date | null = null;
  let sender: string | null = null;
  let time: { hours: number; minutes: number } | null = null;
  const messages: ThreadMessage[] = [];
  let skipped = 0;
  for (const li of items) {
    const headingEl = li.querySelector(".msg-s-message-list__time-heading");
    if (headingEl)
      heading = dateFromHeading(visibleText(headingEl, options), now);
    const nameEl = li.querySelector(
      ".msg-s-message-group__name, .msg-s-message-group__profile-link",
    );
    const name = nameEl ? visibleText(nameEl, options) : "";
    if (name) sender = name;
    const timeEl = li.querySelector(".msg-s-message-group__timestamp");
    if (timeEl) time = timeOfDay(visibleText(timeEl, options)) ?? time;
    const eventId =
      li.querySelector("[data-event-urn]")?.getAttribute("data-event-urn") ??
      null;
    if (!eventId) continue;
    if (!heading || !time || !sender || !selfName) {
      skipped++;
      continue;
    }
    const at = new Date(heading);
    at.setHours(time.hours, time.minutes, 0, 0);
    messages.push({
      direction: sender === selfName ? "outgoing" : "incoming",
      at,
      eventId,
    });
  }
  return {
    messages,
    complete: hasBottom && !loading && skipped === 0 && selfName !== null,
    skipped,
  };
}
/** Base64url SHA-256 of a stable page identifier; the server stores only this. */
export async function fingerprint(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
