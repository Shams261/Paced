import {
  browserVisibility,
  findResultRows,
  parseResultRow,
  parseSelf,
} from "./parse.js";
import { encodeSelectionJson } from "../../../packages/shell-contracts/src/selection-codec.js";
import type {
  Selection,
  SelectionRow,
} from "../../../packages/shell-contracts/src/selection.js";
const DASHBOARD = "https://sequence-dev-etj.pages.dev/";
const VERSION = "0.1.0";
const MARK = "data-paced-row";
function tickbox(row: Element) {
  if (row.hasAttribute(MARK)) return;
  row.setAttribute(MARK, "1");
  const label = document.createElement("label");
  label.style.cssText =
    "display:inline-flex;align-items:center;gap:4px;margin:4px 0;font:12px system-ui;color:#1d2433";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.setAttribute("aria-label", "Select this person for Paced");
  box.addEventListener("change", render);
  label.append(box, document.createTextNode("Paced"));
  (row as HTMLElement).prepend(label);
}
let panel: HTMLElement | undefined;
let self: { profileKey: string | null; profilePath: string | null } = {
  profileKey: null,
  profilePath: null,
};
function detectSelf() {
  const found = parseSelf(document);
  if (found.profilePath || found.profileKey) self = found;
}
function render() {
  if (!panel) {
    panel = document.createElement("section");
    panel.setAttribute("aria-label", "Paced selection");
    panel.style.cssText =
      "position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#fff;border:1px solid #9aa3b5;border-radius:8px;padding:10px 12px;font:13px system-ui;color:#1d2433;max-width:360px;box-shadow:0 4px 16px rgba(0,0,0,.15)";
    document.body.append(panel);
  }
  const count = selectedRows().length;
  const previous = panel.querySelector("[data-paced-result]");
  panel.replaceChildren();
  const title = document.createElement("strong");
  title.textContent = `Paced: ${count} selected`;
  const note = document.createElement("p");
  note.style.margin = "6px 0";
  note.textContent =
    "Reads only the visible fields of ticked rows when you click. Nothing is sent to LinkedIn.";
  const account = document.createElement("p");
  account.style.margin = "6px 0";
  account.textContent =
    self.profilePath || self.profileKey
      ? "Account detected from your LinkedIn menu."
      : 'Account not detected yet: open your LinkedIn "Me" menu once so Paced knows which account this is.';
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Send to Paced";
  button.disabled =
    count === 0 || count > 100 || !(self.profilePath || self.profileKey);
  button.addEventListener("click", send);
  panel.append(title, note, account, button);
  if (previous) panel.append(previous);
}
function selectedRows(): Element[] {
  // Read from the checkboxes that are on the page now, so rows LinkedIn re-rendered
  // after ticking are still found.
  return Array.from(
    document.querySelectorAll<HTMLInputElement>(
      `[${MARK}] input[aria-label="Select this person for Paced"]`,
    ),
  )
    .filter((box) => box.checked)
    .map((box) => box.closest(`[${MARK}]`))
    .filter((row): row is Element => row !== null);
}
function send() {
  if (!panel) return;
  panel.querySelector("[data-paced-result]")?.remove();
  const result = document.createElement("div");
  result.setAttribute("data-paced-result", "1");
  panel.append(result);
  try {
    const rows: SelectionRow[] = selectedRows().map((row) =>
      parseResultRow(row, { isVisible: browserVisibility }),
    );
    if (!rows.length) {
      result.textContent =
        "No ticked rows are on the page any more. Tick again.";
      return;
    }
    const selection: Selection = {
      contract: "paced-selection-1",
      extensionVersion: VERSION,
      capturedAt: new Date().toISOString(),
      pageType: "people-search",
      self,
      rows,
    };
    const preview = document.createElement("pre");
    preview.style.cssText =
      "max-height:160px;overflow:auto;font:11px ui-monospace;white-space:pre-wrap";
    preview.textContent = rows
      .map(
        (r) =>
          `${r.displayName ?? "(no name)"} | ${r.relationship ?? "?"} | ${r.action ?? "?"} | key ${r.profileKey ? "yes" : "NO"}${r.missing.length ? ` | missing: ${r.missing.join(",")}` : ""}`,
      )
      .join("\n");
    const url = `${DASHBOARD}#selection=${encodeSelectionJson(selection)}`;
    // A real link always works even where a scripted new tab is blocked.
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Open Paced with this selection";
    link.style.cssText = "display:inline-block;margin-top:6px;font-weight:600";
    const hint = document.createElement("p");
    hint.style.margin = "6px 0 0";
    hint.textContent =
      "A Paced tab should have opened. If it did not, click the link above.";
    result.append(preview, link, hint);
    window.open(url, "_blank", "noopener");
  } catch (error) {
    result.textContent = `Paced could not read the ticked rows: ${error instanceof Error ? error.message : String(error)}`;
  }
}
function scan() {
  detectSelf();
  for (const row of findResultRows(document)) tickbox(row);
  render();
}
scan();
let pending: number | undefined;
new MutationObserver(() => {
  // The account menu exists only while open, so look for the self link on every mutation;
  // row scanning stays debounced.
  const hadSelf = !!(self.profilePath || self.profileKey);
  detectSelf();
  if (!hadSelf && (self.profilePath || self.profileKey)) render();
  if (pending) return;
  pending = window.setTimeout(() => {
    pending = undefined;
    scan();
  }, 500);
}).observe(document.body, { childList: true, subtree: true });
// Also check right after any click, which is when the account menu opens.
document.addEventListener(
  "click",
  () => {
    window.setTimeout(() => {
      const hadSelf = !!(self.profilePath || self.profileKey);
      detectSelf();
      if (!hadSelf && (self.profilePath || self.profileKey)) render();
    }, 300);
  },
  true,
);
