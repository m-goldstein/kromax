import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  testMatch: "**/*.spec.js",
  workers: 1,
  timeout: process.env.KRONOS_LIVE === "1" ? 900000 : 30000,
  use: {
    baseURL: "http://127.0.0.1:3100",
    viewport: { width: 1440, height: 1100 },
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node test/browser-server.js",
    url: "http://127.0.0.1:3100/api/health",
    reuseExistingServer: false,
  },
});
