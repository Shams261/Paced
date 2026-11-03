import { defineConfig } from "@playwright/test";
// Accessibility checks run against the built hosted dashboard with every request mocked in-page;
// no listener is opened, so the owner's ports stay untouched.
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.a11y\.ts/,
  fullyParallel: false,
  retries: 0,
  reporter: [
    ["list"],
    ["json", { outputFile: "../../.local/a11y-report.json" }],
  ],
  use: { baseURL: "https://sequence-dev-etj.pages.dev", trace: "off" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
