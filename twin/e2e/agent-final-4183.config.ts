import { defineConfig } from "@playwright/test";
// User-authorized test endpoint; assets may be served inside the browser without replacing its owner-managed deployment.
export default defineConfig({
  testDir: ".",
  testMatch: [
    "forecast-mobile-instance.spec.ts",
    "agent-backend-candidates.spec.ts",
    "agent-forecast-stability.spec.ts",
    "forecast-fixed-playback.spec.ts",
    "agent-takeover-live.spec.ts",
    "agent-cancel-immediate.spec.ts",
    "agent-cancel-1600.spec.ts",
    "agent-cancel-restoration.spec.ts",
    "agent-forecast-css1280.spec.ts",
    "agent-chat-human-review.spec.ts",
    "agent-chat-terminated.spec.ts",
    "agent-takeover-prefill.spec.ts",
    "agent-forecast-one-decimal.spec.ts",
  ],
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4183",
    channel: "msedge",
    // Physical 1600x830@1.25 is a 1280x664 CSS viewport.
    viewport: { width: 1280, height: 664 },
    deviceScaleFactor: 1.25,
    timezoneId: "Asia/Shanghai",
    reducedMotion: "reduce",
  },
});
