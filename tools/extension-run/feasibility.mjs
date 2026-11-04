// Owner-driven feasibility run: headed Chromium with the unpacked extension, the owner signs in,
// the script ticks up to five Connect rows and captures the selection the extension produces.
// Prints counts only; the selection URL is written to a file in the scratchpad, never printed.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const dist = resolve("apps/extension/dist");
const scratch = process.env.PACED_RUN_DIR;
if (!scratch) throw new Error("PACED_RUN_DIR is required");
mkdirSync(scratch, { recursive: true });
const search =
  "https://www.linkedin.com/search/results/people/?currentCompany=%5B%221035%22%5D&keywords=software%20engineer&origin=FACETED_SEARCH";
const context = await chromium.launchPersistentContext(resolve(scratch, "profile"), {
  channel: "chromium",
  headless: false,
  viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
context.on("close", () => console.log("browser window closed"));
const page = await context.newPage();
page.on("crash", () => console.log("page crashed"));
await page.goto(search);
console.log(
  "Sign in to LinkedIn in the opened window (secondary account). Waiting up to 10 minutes for the search results...",
);
await page.waitForFunction(
  () =>
    document.querySelectorAll('main [role=listitem] a[href*="/in/"], main li a[href*="/in/"]').length >= 3,
  null,
  { timeout: 600000 },
);
if (!page.url().startsWith("https://www.linkedin.com/search/results/people/")) await page.goto(search);
await page.waitForSelector('input[aria-label="Select this person for Paced"]', { timeout: 30000 });
const boxes = await page.$$('input[aria-label="Select this person for Paced"]');
console.log(`rows with Paced checkbox: ${boxes.length}`);
// Open and close the account menu once so the extension can read the signed-in identity.
const me = page.getByRole("button", { name: /^Me$/ }).first();
if (await me.count()) {
  await me.click();
  await page.waitForTimeout(1500);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);
}
let ticked = 0;
for (const box of boxes) {
  if (ticked >= 5) break;
  const row = await box.evaluateHandle((b) => b.closest("[data-paced-row]"));
  const action = await row.evaluate(
    (r) =>
      Array.from(r.querySelectorAll("button, a"))
        .map((e) => e.innerText.trim())
        .find((t) => ["Connect", "Pending", "Message", "Follow"].includes(t)) ?? "other",
  );
  if (action !== "Connect") continue;
  await box.check();
  ticked++;
}
console.log(`ticked (Connect rows): ${ticked}`);
const panel = await page.textContent('section[aria-label="Paced selection"]');
console.log(`panel: ${panel?.replace(/\s+/g, " ").trim().slice(0, 200)}`);
const popupPromise = context.waitForEvent("page", { timeout: 15000 }).catch(() => null);
await page.getByRole("button", { name: "Send to Paced" }).click();
const popup = await popupPromise;
const url = popup ? popup.url() : null;
if (popup) await popup.close();
if (url && url.includes("#selection=")) {
  writeFileSync(resolve(scratch, "selection-url.txt"), url);
  const fragment = url.split("#selection=")[1];
  const json = JSON.parse(
    Buffer.from(fragment.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
  );
  console.log(
    JSON.stringify(
      {
        rows: json.rows.length,
        withKey: json.rows.filter((r) => r.profileKey).length,
        keyNamespaces: [
          ...new Set(json.rows.map((r) => (r.profileKey ?? "none").split(":").slice(0, 3).join(":"))),
        ],
        missing: json.rows.map((r) => r.missing),
        actions: json.rows.map((r) => r.action),
        relationships: json.rows.map((r) => r.relationship),
        fieldsPresent: json.rows.map((r) =>
          ["displayName", "headline", "location", "current"].filter((f) => r[f]),
        ),
        selfDetected: !!(json.self.profileKey || json.self.profilePath),
      },
      null,
      1,
    ),
  );
} else {
  console.log("no dashboard tab was opened; panel state above explains why");
}
await context.close();
console.log("done; browser closed");
