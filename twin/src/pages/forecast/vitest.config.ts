import { defineConfig } from "vitest/config";
// Keep page-local tests runnable without modifying the shared test config.
export default defineConfig({
  test: {
    include: ["src/pages/forecast/*.test.ts", "src/pages/forecast/*.test.tsx"],
  },
});
