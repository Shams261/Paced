import {
  parseSelf,
  profileKeyFromHref,
  profilePathFromHref,
  visibleText,
  type ParseOptions,
} from "./parse.js";
/** What a profile page shows about one person, read from visible text and the page's own attributes. */
export interface ProfileObservation {
  profilePath: string | null;
  profileKey: string | null;
  displayName: string | null;
  relationship: "1st" | "2nd" | "3rd" | "other" | null;
  actions: string[];
  connection: "Unknown" | "NotConnected" | "Pending" | "Connected";
  /** Link to the message thread with this person, when the page offers one. */
  messageHref: string | null;
  unreadable: boolean;
  self: { profileKey: string | null; profilePath: string | null };
}
const actionLabels = ["Connect", "Pending", "Message", "Follow", "More"];
/** The top card is the first section in main; everything else on the page belongs to other people. */
export function topCard(root: ParentNode): Element | null {
  const main = root.querySelector("main");
  if (!main) return null;
  return main.querySelector("section") ?? main;
}
export function parseProfile(
  root: ParentNode,
  options: ParseOptions,
  pathname = (root as Document).defaultView?.location.pathname ?? "",
): ProfileObservation {
  const card = topCard(root);
  const self = parseSelf(root);
  const canonical = root
    .querySelector('link[rel="canonical"]')
    ?.getAttribute("href");
  const profilePath =
    profilePathFromHref(pathname) ??
    (canonical ? profilePathFromHref(canonical) : null);
  if (!card)
    return {
      profilePath,
      profileKey: null,
      displayName: null,
      relationship: null,
      actions: [],
      connection: "Unknown",
      messageHref: null,
      unreadable: true,
      self,
    };
  const heading = Array.from(card.querySelectorAll("h1, h2"))
    .map((h) => visibleText(h, options))
    .find((t) => t.length > 0);
  const cardText = visibleText(card, options);
  const degree = /(^|\s)(1st|2nd|3rd)\+?(\s|$)/.exec(cardText)?.[2] as
    "1st" | "2nd" | "3rd" | undefined;
  const controls = Array.from(card.querySelectorAll("a, button"));
  const actions = Array.from(
    new Set(
      controls
        .map((b) => visibleText(b, options))
        .filter((t) => actionLabels.includes(t)),
    ),
  );
  const profileKey =
    controls
      .flatMap((e) => Array.from(e.attributes).map((a) => a.value))
      .map(profileKeyFromHref)
      .find((k) => k) ?? null;
  const messageHref =
    controls
      .map((a) => a.getAttribute("href") ?? "")
      .find((h) => h.includes("/messaging/")) ?? null;
  const connection: ProfileObservation["connection"] = actions.includes(
    "Pending",
  )
    ? "Pending"
    : degree === "1st"
      ? "Connected"
      : actions.includes("Connect")
        ? "NotConnected"
        : "Unknown";
  const unreadable = !heading || (actions.length === 0 && !degree);
  return {
    profilePath,
    profileKey,
    displayName: heading ?? null,
    relationship: degree ?? (cardText ? "other" : null),
    actions,
    connection,
    messageHref,
    unreadable,
    self,
  };
}
