import { PROFILE_KEY_PATTERN } from "../../../packages/shell-contracts/src/selection-codec.js";
import type { SelectionRow } from "../../../packages/shell-contracts/src/selection.js";
/**
 * Pure, visible-only parsing of one LinkedIn people-search result row.
 * No network, no storage, no innerHTML. Anything absent is reported in `missing`.
 */
export interface ParseOptions {
  isVisible: (element: Element) => boolean;
}
/**
 * Sighted visibility: not display:none, not visibility:hidden, not a clipped screen-reader-only
 * block, and rendered (display:contents wrappers have no box of their own but their children do).
 */
export const browserVisibility: ParseOptions["isVisible"] = (element) => {
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (style.display === "contents") return true;
  if (
    style.position === "absolute" &&
    (parseFloat(style.width) <= 1 || parseFloat(style.height) <= 1)
  )
    return false;
  return element.getClientRects().length > 0;
};
function hiddenByAttribute(element: Element): boolean {
  return (
    element.getAttribute("aria-hidden") === "false" ||
    element.classList.contains("visually-hidden") ||
    element.classList.contains("sr-only")
  );
}
/** Visible text of an element: text nodes whose ancestors are all visible. */
export function visibleText(root: Element, options: ParseOptions): string {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    if (hiddenByAttribute(element) || !options.isVisible(element)) return;
    for (const child of Array.from(element.childNodes)) walk(child);
  };
  walk(root);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
/** A stable key from any attribute value: fsd_profile hashes (profile pages) or numeric member IDs (search rows). */
export function profileKeyFromHref(href: string): string | null {
  const fsd = /fsd_profile(?:%3A|:)([A-Za-z0-9_-]{4,120})/.exec(href);
  const member = /urn(?:%3A|:)li(?:%3A|:)member(?:%3A|:)([0-9]{1,20})/.exec(
    href,
  );
  const key = fsd
    ? `urn:li:fsd_profile:${fsd[1]}`
    : member
      ? `urn:li:member:${member[1]}`
      : null;
  return key && PROFILE_KEY_PATTERN.test(key) ? key : null;
}
export function profilePathFromHref(href: string): string | null {
  const match = /\/in\/([A-Za-z0-9%._-]{1,200})\/?(?:[?#]|$)/.exec(href);
  return match ? `/in/${match[1]}/` : null;
}
const relationships = ["1st", "2nd", "3rd"] as const;
const actions = ["Connect", "Pending", "Message", "Follow"] as const;
export function parseResultRow(
  row: Element,
  options: ParseOptions,
): SelectionRow {
  const anchors = Array.from(
    row.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]'),
  );
  const profilePath =
    anchors
      .map((a) => profilePathFromHref(a.getAttribute("href") ?? ""))
      .find((p) => p) ?? null;
  // Keys appear in link hrefs on older layouts and in componentkey/data attributes on newer ones.
  const keySources = [
    ...anchors.map((a) => a.getAttribute("href") ?? ""),
    ...Array.from(
      row.querySelectorAll(
        "[componentkey],[data-entity-urn],[data-urn],[data-view-name]",
      ),
    ).flatMap((e) => Array.from(e.attributes).map((a) => a.value)),
  ];
  const profileKey = keySources.map(profileKeyFromHref).find((k) => k) ?? null;
  // Newer layouts wrap the whole card in a profile link; the name link is the shortest one with text.
  const nameAnchor = anchors
    .map((a) => ({ a, text: visibleText(a, options) }))
    .filter((x) => x.text.length > 0)
    .sort((x, y) => x.text.length - y.text.length)[0];
  let displayName = nameAnchor ? nameAnchor.text : "";
  displayName = displayName
    .replace(/^View\s+/i, "")
    .replace(/['’]s profile$/i, "")
    .trim();
  const rowText = visibleText(row, options);
  const relationship =
    relationships.find((r) => new RegExp(`(^|\\s)${r}(\\s|$)`).test(rowText)) ??
    (rowText ? "other" : null);
  // The primary action is a button or a link whose visible text is exactly the action word.
  const buttons = Array.from(row.querySelectorAll("button, a")).filter((b) =>
    actions.some((a) => visibleText(b, options) === a),
  );
  const actionText = buttons.map((b) => visibleText(b, options))[0];
  const action = actionText
    ? (actions.find((a) => actionText.startsWith(a)) ?? "other")
    : buttons.length
      ? "other"
      : null;
  // Remaining visible blocks after the name line: LinkedIn renders headline, then location.
  const blocks = Array.from(row.querySelectorAll("div, p, span"))
    .filter(
      (e) =>
        e.children.length === 0 ||
        Array.from(e.children).every(
          (c) => c.tagName === "SPAN" || c.tagName === "STRONG",
        ),
    )
    .map((e) => visibleText(e, options))
    .filter(
      (t) =>
        t.length > 0 &&
        t !== displayName &&
        !relationships.some((r) => t === r || t === `• ${r}`) &&
        !actions.some((a) => t.startsWith(a)),
    )
    .filter((t, i, all) => all.indexOf(t) === i && !displayName.includes(t));
  const current = blocks.find((t) => /^Current:/i.test(t)) ?? null;
  const rest = blocks.filter((t) => t !== current);
  const headline = rest[0] ?? null;
  const location = rest[1] ?? null;
  const missing: string[] = [];
  if (!profileKey) missing.push("profileKey");
  if (!profilePath) missing.push("profilePath");
  if (!displayName) missing.push("displayName");
  if (!headline) missing.push("headline");
  if (!location) missing.push("location");
  if (!relationship) missing.push("relationship");
  if (!action) missing.push("action");
  return {
    profileKey,
    profilePath,
    displayName: displayName || null,
    headline: headline ? headline.slice(0, 400) : null,
    location: location ? location.slice(0, 200) : null,
    current: current ? current.slice(0, 300) : null,
    relationship,
    action,
    missing,
  };
}
/** Result rows are list items (li or role=listitem) in the main results area that link to a profile. */
export function findResultRows(root: ParentNode): Element[] {
  const main = (root as Document).querySelector?.("main") ?? root;
  const seen = new Set<string>();
  return Array.from(main.querySelectorAll("li, [role=listitem]")).filter(
    (li) => {
      const anchor = li.querySelector('a[href*="/in/"]');
      const path = anchor
        ? profilePathFromHref(anchor.getAttribute("href") ?? "")
        : null;
      if (!path || seen.has(path)) return false;
      // :scope keeps the ancestor test inside this element; without it a row's own
      // role matches and every row is treated as a wrapper around itself.
      if (
        li.querySelector(
          ":scope li a[href*='/in/'], :scope [role=listitem] a[href*='/in/']",
        )
      )
        return false;
      seen.add(path);
      return true;
    },
  );
}
/**
 * The signed-in identity from the page's own navigation, never from the result rows.
 * The current layout exposes it only after the user opens the account ("Me") menu,
 * which renders a profile link outside the results; nothing is clicked by the extension.
 */
export function parseSelf(root: ParentNode): {
  profileKey: string | null;
  profilePath: string | null;
} {
  const main = (root as Document).querySelector?.("main");
  const outside = Array.from(
    (root as Document).querySelectorAll?.('a[href*="/in/"]') ?? [],
  ).filter((a) => !main || !main.contains(a));
  const menuLink = outside.find((a) =>
    profilePathFromHref(a.getAttribute("href") ?? ""),
  );
  if (menuLink) {
    const href = menuLink.getAttribute("href") ?? "";
    return {
      profileKey: profileKeyFromHref(href),
      profilePath: profilePathFromHref(href),
    };
  }
  const scopes = [
    (root as Document).querySelector?.("#global-nav"),
    (root as Document).querySelector?.("header"),
    (root as Document).querySelector?.("nav"),
  ].filter((s): s is Element => !!s);
  for (const scope of scopes) {
    const anchor = Array.from(
      scope.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]'),
    )[0];
    if (anchor) {
      const href = anchor.getAttribute("href") ?? "";
      return {
        profileKey: profileKeyFromHref(href),
        profilePath: profilePathFromHref(href),
      };
    }
  }
  return { profileKey: null, profilePath: null };
}
