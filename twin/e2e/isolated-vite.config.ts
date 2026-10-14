import { defineConfig, mergeConfig } from "vite";
import productConfig from "../vite.config";

// Test-only proxy: the product Vite config targets resident 8000 by default.
// Keep every real HTTP/API request on the owned disposable backend instead.
const target = process.env.AGNES_TEST_BACKEND;
if (!target || !/^http:\/\/127\.0\.0\.1:\d+$/.test(target))
  throw new Error("Owned test backend required");
if ([8000, 8006, 4181, 4186, 4187].includes(Number(new URL(target).port)))
  throw new Error("Resident backend forbidden");
export default mergeConfig(productConfig, defineConfig({
  server: { proxy: { "/api": { target, changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/api(?=\/|$)/, "") || "/" } } },
}));
