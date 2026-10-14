import { defineConfig } from "@playwright/test";

// Separate port for concurrent page sessions: $env:PLAYWRIGHT_PORT='5187'.
const port = Number(process.env.PLAYWRIGHT_PORT ?? 5173);
const url = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  use: {
    baseURL: url,
    channel: "msedge",
    // Headless Edge otherwise caps even an empty page around 32fps.
    launchOptions:{args:['--disable-frame-rate-limit','--disable-gpu-vsync']},
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  },
  webServer: {
    command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${port} --strictPort`,
    url,
    reuseExistingServer: false,
  },
});
