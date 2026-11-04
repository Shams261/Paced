import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { encodeSelection } from "../../packages/shell-contracts/src/selection.js";

const dist = join(import.meta.dirname, "../../apps/dashboard/dist");
const origin = "https://sequence-dev-etj.pages.dev";
const snapshot = {
  page: 0,
  sendingEnabled: false,
  totalProspects: 2,
  totalEnrollments: 2,
  prospects: [
    {
      id: "p1",
      display_name: "Ada Example",
      role_title: "Software Engineer",
      company: "Example Systems",
      connection: "NotConnected",
      revision: 1,
    },
    {
      id: "p2",
      display_name: "Dev Example",
      role_title: "Engineer",
      company: null,
      connection: "Unknown",
      revision: 1,
    },
  ],
  lists: [{ id: "l1", name: "Fictional engineering prospects", count: 2 }],
  campaigns: [
    {
      id: "c1",
      name: "Sample campaign",
      revision: 1,
      status: "Draft",
      approved: false,
      recipients: ["p1"],
      content: {
        note: "Hi {{name}}",
        firstMessage: "Thanks {{name}}",
        followups: [],
      },
    },
  ],
  enrollments: [
    {
      id: "e1",
      campaign_id: "c1",
      prospect_id: "p1",
      display_name: "Ada Example",
      status: "Held",
      stop_reason: "execution-disabled",
    },
    {
      id: "e2",
      campaign_id: "c1",
      prospect_id: "p2",
      display_name: "Dev Example",
      status: "Held",
      stop_reason: "needs-verification",
    },
  ],
};
const status = {
  checkedAt: "2026-11-03T00:00:00Z",
  sendingEnabled: false,
  growthAllowed: true,
  reasons: [],
  meters: [
    {
      name: "database_bytes",
      value: 1,
      limit: 100,
      percent: 5.6,
      state: "ok",
      measuredAt: "x",
      source: "pg",
      providerReadingAt: "x",
      providerVerified: true,
    },
  ],
  recovery: {
    state: "ok",
    note: "A backup younger than 24 hours is recorded.",
  },
  totalProspects: 2,
  totalCampaigns: 1,
  health: {
    oldestDueAt: null,
    dueCount: 0,
    heldCount: 2,
    waitingCount: 0,
    uncertainSends: 0,
    unknownOutcomes: 0,
    executors: "none-registered",
  },
};
const approval = {
  fingerprint: "abc",
  recipients: [
    {
      id: "p1",
      name: "Ada Example",
      disposition: "Held",
      content: {
        note: "Hi Ada Example",
        firstMessage: "Thanks Ada Example",
        followups: [],
      },
    },
  ],
};

const selection = {
  contract: "paced-selection-1" as const,
  extensionVersion: "0.1.0",
  capturedAt: "2026-11-04T00:00:00.000Z",
  pageType: "people-search" as const,
  self: { profileKey: null, profilePath: "/in/self-example/" },
  rows: [
    {
      profileKey: "urn:li:member:1",
      profilePath: "/in/ada-example/",
      displayName: "Ada Example",
      headline: "Software Engineer at Example Systems",
      location: "Toronto, Canada",
      current: "Current: Software Engineer at Example Systems",
      relationship: "2nd" as const,
      action: "Connect" as const,
      missing: [],
    },
    {
      profileKey: null,
      profilePath: "/in/finn-example/",
      displayName: "Finn Example",
      headline: null,
      location: null,
      current: null,
      relationship: "3rd" as const,
      action: "Follow" as const,
      missing: ["profileKey", "headline", "location"],
    },
  ],
};
const externalPreview = {
  source: "extension-v1",
  binding: "will-bind",
  rows: [
    {
      profileKey: "urn:li:member:1",
      displayName: "Ada Example",
      role: "Software Engineer",
      company: "Example Systems",
      location: "Toronto, Canada",
      connection: "NotConnected",
      importable: true,
      reason: null,
      existing: false,
    },
    {
      profileKey: null,
      displayName: "Finn Example",
      role: null,
      company: null,
      location: null,
      connection: "Unknown",
      importable: false,
      reason: "no stable identifier",
      existing: false,
    },
  ],
};
const browsers = {
  executionMode: "disabled",
  timezone: "Asia/Kolkata",
  acknowledgedAt: null,
  bound: true,
  executors: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      label: "Laptop",
      adapterVersion: "0.2.0",
      createdAt: "2026-11-04T10:00:00Z",
      lastSeenAt: null,
      revokedAt: null,
    },
  ],
};
type Mode = "signed-out" | "admitted" | "outage";
async function mock(page: Page, mode: Mode) {
  const assets = readdirSync(join(dist, "assets"));
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown, statusCode = 200) =>
      route.fulfill({
        status: statusCode,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (url.pathname === "/api/auth/session")
      return mode === "signed-out"
        ? json({ state: "signed-out" })
        : json({ state: "admitted", csrfToken: "csrf" });
    if (url.pathname === "/api/v1/management")
      return mode === "outage"
        ? json({ error: "STORAGE_UNAVAILABLE" }, 503)
        : route.request().method() === "POST" &&
            JSON.parse(route.request().postData() ?? "{}").operation ===
              "approval-preview"
          ? json(approval)
          : route.request().method() === "POST" &&
              JSON.parse(route.request().postData() ?? "{}").operation ===
                "import-preview-external"
            ? json(externalPreview)
            : json(
                route.request().method() === "POST"
                  ? { campaignId: "c1", revision: 1 }
                  : snapshot,
              );
    if (url.pathname === "/api/v1/status") return json(status);
    if (url.pathname === "/api/v1/executors")
      return route.request().method() === "POST" &&
        JSON.parse(route.request().postData() ?? "{}").operation === "pair-code"
        ? json({ code: "ABCD2345", expiresAt: "2026-11-04T10:05:00Z" })
        : json(browsers);
    if (url.pathname === "/api/v1/export")
      return route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body: '{"type":"manifest"}\n{"type":"end","pages":0}\n',
      });
    if (url.pathname === "/api/v1/delete-workspace")
      return json({ error: "REAUTHENTICATION_REQUIRED" }, 403);
    if (url.pathname === "/" || url.pathname === "/index.html")
      return route.fulfill({
        status: 200,
        contentType: "text/html",
        body: readFileSync(join(dist, "index.html"), "utf8"),
      });
    const asset = assets.find((a) => url.pathname === `/assets/${a}`);
    if (asset)
      return route.fulfill({
        status: 200,
        contentType: asset.endsWith(".css") ? "text/css" : "text/javascript",
        body: readFileSync(join(dist, "assets", asset), "utf8"),
      });
    return route.fulfill({ status: 404, body: "not mocked" });
  });
}
async function axe(page: Page, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const serious = results.violations.filter((v) =>
    ["serious", "critical"].includes(v.impact ?? ""),
  );
  expect(
    serious.map((v) => `${label}: ${v.id} (${v.nodes.length} nodes) ${v.help}`),
    `${label}: serious or critical accessibility violations`,
  ).toEqual([]);
  const lower = results.violations.map((v) => `${v.impact}:${v.id}`);
  if (lower.length)
    console.log(`[axe ${label}] lower-impact: ${lower.join(", ")}`);
  return lower;
}
async function focusedHasVisibleOutline(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return "no-focus";
    const s = getComputedStyle(el);
    const outline = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0;
    const ring = s.boxShadow !== "none";
    return outline || ring
      ? "visible"
      : `hidden:${el.tagName}:${(el as HTMLButtonElement).innerText?.slice(0, 20)}`;
  });
}

test("sign-in page: axe clean and the sign-in button is reachable by keyboard", async ({
  page,
}) => {
  await mock(page, "signed-out");
  await page.goto(`${origin}/`);
  await expect(
    page.getByRole("button", { name: "Sign in with Google" }),
  ).toBeVisible();
  await axe(page, "sign-in");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Sign in with Google" }),
  ).toBeFocused();
  expect(await focusedHasVisibleOutline(page)).toBe("visible");
});

test("admitted workspace: import preview, draft, review, approve, pause, stop, export and delete by keyboard only", async ({
  page,
}) => {
  await mock(page, "admitted");
  await page.goto(`${origin}/`);
  await expect(page.getByText("Access approved")).toBeVisible();
  await expect(page.getByText(/Queue: 0 due/)).toBeVisible();
  await axe(page, "workspace");
  // Import preview and confirm through the keyboard.
  await page.getByRole("button", { name: "Preview import" }).focus();
  expect(await focusedHasVisibleOutline(page)).toBe("visible");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Preview ready/)).toBeVisible();
  await axe(page, "import-preview");
  await page.getByRole("button", { name: "Confirm import" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Saved by the server/)).toBeVisible();
  // Connected browsers: generate a pairing code through the keyboard and read it as a status.
  await page.getByRole("button", { name: "Generate pairing code" }).focus();
  expect(await focusedHasVisibleOutline(page)).toBe("visible");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("status").filter({ hasText: "ABCD2345" }),
  ).toBeVisible();
  await axe(page, "browsers");
  // Draft: select a campaign with the keyboard, edit the first message, save.
  await page.getByLabel("Campaign", { exact: true }).focus();
  await page.getByLabel("Campaign", { exact: true }).selectOption("c1");
  await page.getByLabel("First message").focus();
  await page.keyboard.type(" Keyboard edit.");
  await page.getByRole("button", { name: "Save draft" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Saved by the server/)).toBeVisible();
  await axe(page, "draft");
  // Review exact outreach and approve.
  await page.getByRole("button", { name: "Review exact outreach" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("First message: Thanks Ada Example"),
  ).toBeVisible();
  await axe(page, "review");
  await page
    .getByRole("button", { name: "Approve this saved revision" })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Saved by the server/)).toBeVisible();
  // Pause and stop.
  await page.getByRole("button", { name: "Pause campaign" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Saved by the server/)).toBeVisible();
  await page.getByRole("button", { name: "Stop campaign" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Saved by the server/)).toBeVisible();
  // Progress states are visible text, not colour only.
  await expect(page.getByText("needs-verification")).toBeVisible();
  // Export through the keyboard; an incomplete-looking file is rejected honestly.
  await page.getByRole("button", { name: "Download my data" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Export downloaded: 2 lines/)).toBeVisible();
  // Delete: the button stays disabled until the exact phrase is typed; a stale sign-in is explained.
  const del = page.getByRole("button", { name: "Delete my workspace" });
  await expect(del).toBeDisabled();
  await page.getByLabel(/to confirm/).focus();
  await page.keyboard.type("DELETE MY WORKSPACE");
  await expect(del).toBeEnabled();
  await del.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/needs a fresh sign-in/)).toBeVisible();
  await axe(page, "delete");
});

test("service outage: the error state is announced and axe clean", async ({
  page,
}) => {
  await mock(page, "outage");
  await page.goto(`${origin}/`);
  await expect(
    page.getByRole("status").filter({ hasText: /could not be loaded/ }),
  ).toBeVisible();
  await axe(page, "outage");
  await page.getByRole("button", { name: "Reload saved data" }).focus();
  expect(await focusedHasVisibleOutline(page)).toBe("visible");
});

test("LinkedIn selection: the signed-out notice and the import preview are axe clean and the import completes by keyboard", async ({
  page,
}) => {
  const fragment = `#selection=${encodeSelection(selection)}`;
  // Signed out: the selection is kept in the tab and the sign-in button is the only action.
  await mock(page, "signed-out");
  await page.goto(`${origin}/${fragment}`);
  await expect(
    page.getByRole("status").filter({ hasText: /kept in this tab/ }),
  ).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");
  await axe(page, "selection-signed-out");
  // After sign-in the page loads without the fragment and restores the selection.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await mock(page, "admitted");
  await page.goto(`${origin}/`);
  await expect(page.getByText("Access approved")).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Import from LinkedIn selection" }),
  ).toBeVisible();
  await expect(
    page.getByText(/this import will link your workspace/),
  ).toBeVisible();
  // Non-importable rows say why in text, not colour.
  await expect(
    page.getByText(/not importable \(no stable identifier\)/),
  ).toBeVisible();
  await axe(page, "selection-preview");
  // Name the list and confirm through the keyboard only.
  await page.getByLabel("Name for this list").focus();
  expect(await focusedHasVisibleOutline(page)).toBe("visible");
  await page.keyboard.type("Keyboard import");
  const confirm = page.getByRole("button", {
    name: "Confirm import of 1 people",
  });
  await confirm.focus();
  expect(await focusedHasVisibleOutline(page)).toBe("visible");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Saved by the server/)).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Import from LinkedIn selection" }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => sessionStorage.getItem("paced.selection")),
  ).toBeNull();
  await axe(page, "selection-imported");
});
