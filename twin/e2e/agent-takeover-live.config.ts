import { defineConfig } from "@playwright/test";
// Explicit opt-in only: 4183 is the user-authorized disposable test database.
export default defineConfig({
  testDir: ".",
  testMatch: "agent-takeover-live.spec.ts",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4183",
    channel: "msedge",
    viewport: { width: 1366, height: 768 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  },
});
