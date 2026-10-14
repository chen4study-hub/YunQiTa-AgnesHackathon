import { it, expect } from "vitest";
import config from "../vite.config";
it("development and preview proxy /api to local backend with stripped prefix", () => {
  for (const proxy of [config.server?.proxy, config.preview?.proxy]) {
    const api = proxy?.["/api"];
    expect(api).toBeTypeOf("object");
    if (!api || typeof api === "string") throw new Error("Missing API proxy");
    expect(api.target).toBe("http://127.0.0.1:8000");
    expect(api.rewrite?.("/api/health")).toBe("/health");
    expect(api.rewrite?.("/api/chat?origin=10")).toBe("/chat?origin=10");
    expect(api.rewrite?.("/api")).toBe("/");
  }
});
