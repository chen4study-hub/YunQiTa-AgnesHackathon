import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
const port = Number(process.env.PLAYWRIGHT_PORT ?? 5197);
export default defineConfig({
  testDir: ".",
  testMatch: [
    "scene-smoothness.spec.ts",
    "scene-lifecycle-performance.spec.ts",
    "scene-paused.spec.ts",
  ],
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel: "msedge",
    launchOptions: {
      args:
        process.env.SCENE_NORMAL_VSYNC === "1"
          ? []
          : ["--disable-frame-rate-limit", "--disable-gpu-vsync"],
    },
    headless: process.env.SCENE_HEADED !== "1",
    viewport: { width: 1366, height: 768 },
    deviceScaleFactor: 1,
    reducedMotion: "no-preference",
  },
  webServer: {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    command: `node node_modules/vite/bin/vite.js preview ${process.env.SCENE_PREVIEW_CONFIG ? `--config ${process.env.SCENE_PREVIEW_CONFIG}` : ""} --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
});
