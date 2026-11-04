import type {
  ExecutorObservation,
  WatchedPerson,
} from "../../../packages/shell-contracts/src/executor.js";
import { browserVisibility, parseSelf, visibleText } from "./parse.js";
import { parseProfile, topCard } from "./profile.js";
import { fingerprint, parseThread } from "./thread.js";
/**
 * Content script for profile and thread pages the user opens. If the page belongs to an
 * enrolled person, it reads what is visible and reports it through the background relay.
 * It never navigates, clicks or reads message text.
 */
const options = { isVisible: browserVisibility };
const MARK = "paced-observed";
function send<T>(message: unknown): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}
function normalisePath(path: string | null): string | null {
  return path ? path.replace(/\/?$/, "/") : null;
}
function note(text: string) {
  let panel = document.querySelector<HTMLElement>(`[data-${MARK}]`);
  if (!panel) {
    panel = document.createElement("aside");
    panel.setAttribute(`data-${MARK}`, "1");
    panel.setAttribute("aria-label", "Paced observation");
    panel.style.cssText =
      "position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#fff;border:1px solid #9aa3b5;border-radius:8px;padding:8px 12px;font:12px system-ui;color:#1d2433;max-width:320px;box-shadow:0 4px 16px rgba(0,0,0,.15)";
    document.body.append(panel);
  }
  panel.textContent = text;
}
/** The signed-in identity: the account menu link, plus the name when the user is on their own profile. */
async function reportSelf() {
  const self = parseSelf(document);
  if (!self.profilePath && !self.profileKey) return;
  const own =
    normalisePath(self.profilePath) === normalisePath(location.pathname);
  const card = own ? topCard(document) : null;
  const name = card
    ? (Array.from(card.querySelectorAll("h1, h2"))
        .map((h) => visibleText(h, options))
        .find((t) => t.length > 0) ?? null)
    : null;
  await send({ type: "paced:self", self: { ...self, name } });
}
export function matchProfile(
  people: WatchedPerson[],
  path: string | null,
  key: string | null,
): WatchedPerson | undefined {
  return people.find(
    (p) =>
      (key !== null && p.recipientKey === key) ||
      (path !== null &&
        p.profilePath !== null &&
        normalisePath(p.profilePath) === normalisePath(path)),
  );
}
/** A thread shows the other person's name but no profile link; only an unambiguous name match counts. */
export function matchThread(
  people: WatchedPerson[],
  root: ParentNode = document,
): WatchedPerson | undefined {
  const main = root.querySelector("main");
  if (!main) return undefined;
  const names = Array.from(main.querySelectorAll("h2, h3"))
    .map((h) => visibleText(h, options))
    .filter((t) => t.length > 0);
  for (const name of names) {
    const matches = people.filter((p) => p.displayName === name);
    if (matches.length === 1) return matches[0];
  }
  return undefined;
}
let last = "";
async function run() {
  try {
    await reportSelf();
    const list = await send<{
      people: WatchedPerson[];
      reason: string | null;
      selfName: string | null;
      error?: string;
    }>({ type: "paced:watchlist" });
    if (list.error || !list.people.length) return;
    let observation: ExecutorObservation | null = null;
    let who: WatchedPerson | undefined;
    if (location.pathname.startsWith("/in/")) {
      const profile = parseProfile(document, options);
      who = matchProfile(list.people, profile.profilePath, profile.profileKey);
      if (!who) return;
      observation = {
        prospectId: who.prospectId,
        observedAt: new Date().toISOString(),
        connection: profile.connection,
        complete: !profile.unreadable,
        unreadable: profile.unreadable,
      };
    } else if (location.pathname.startsWith("/messaging/")) {
      who = matchThread(list.people);
      if (!who) return;
      const thread = parseThread(document, options, list.selfName);
      if (!thread.messages.length && !thread.complete) return;
      observation = {
        prospectId: who.prospectId,
        observedAt: new Date().toISOString(),
        connection: "Unknown",
        complete: thread.complete,
        messages: await Promise.all(
          thread.messages.map(async (m) => ({
            direction: m.direction,
            at: m.at.toISOString(),
            fingerprint: await fingerprint(m.eventId),
          })),
        ),
      };
    }
    if (!observation || !who) return;
    const key = JSON.stringify({ ...observation, observedAt: null });
    if (key === last) return;
    last = key;
    const result = await send<{
      stored?: number;
      duplicates?: number;
      error?: string;
    }>({ type: "paced:observe", observation });
    note(
      result.error
        ? `Paced could not record this page: ${result.error}.`
        : `Paced recorded what is visible for ${who.displayName} (${observation.connection === "Unknown" ? "message thread" : observation.connection}). Nothing was sent to LinkedIn.`,
    );
  } catch (error) {
    note(
      `Paced could not record this page: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
}
let pending: number | undefined;
function scheduleRun() {
  if (pending) window.clearTimeout(pending);
  pending = window.setTimeout(() => {
    pending = undefined;
    void run();
  }, 1500);
}
if (typeof chrome !== "undefined" && chrome.runtime?.id) {
  scheduleRun();
  new MutationObserver(scheduleRun).observe(document.body, {
    childList: true,
    subtree: true,
  });
  document.addEventListener("click", scheduleRun, true);
}
