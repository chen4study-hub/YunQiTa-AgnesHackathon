import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import productConfig from "../playwright.config";
import { RESOURCE_LIMITED_LAUNCH } from "./viewport-profile";

// Retain all product defaults/assertions; constrain resources and redirect only
// this disposable clone's API. No fixture alters product response contracts.
const port = Number(process.env.PLAYWRIGHT_PORT ?? 5227);
export default defineConfig({
  ...productConfig,
  testDir: ".",
  workers: 1,
  use: { ...productConfig.use, launchOptions: RESOURCE_LIMITED_LAUNCH },
  webServer: {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    command: `node node_modules/vite/bin/vite.js --config e2e/isolated-vite.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
});
