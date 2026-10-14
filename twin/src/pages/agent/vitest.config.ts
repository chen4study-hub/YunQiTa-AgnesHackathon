import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "src/pages/agent/*.test.ts",
      "src/pages/agent/*.test.tsx",
      "src/pages/forecast/*.test.tsx",
    ],
  },
});
