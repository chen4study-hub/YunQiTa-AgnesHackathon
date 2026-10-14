// Scoped config because the project's default config only discovers tests/.
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { environment: "node", include: ["src/data/ops/**/*.test.ts"] },
});
