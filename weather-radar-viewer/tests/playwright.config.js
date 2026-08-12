// Playwright config for the SKYWATCH PWA smoke suite.
// All external feeds are stubbed inside the specs (see smoke/_setup.js) —
// the suite is deterministic and needs no live network.
const { defineConfig } = require("@playwright/test");

const launchOptions = {};
// The dev sandbox provides a pre-installed Chromium (e.g.
// PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium). CI installs its own
// browser via `npx playwright install chromium` and leaves this unset.
if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
  launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
}

module.exports = defineConfig({
  testDir: "./smoke",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:8471",
    viewport: { width: 1024, height: 600 },
    launchOptions,
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
  ],
  webServer: {
    command: "python3 -m http.server 8471 --directory ../pwa",
    url: "http://localhost:8471/",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
