import { test as base, expect } from "@playwright/test";
import { freezeTestHmr } from "./shell-scroll-policy";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";

/** Regression isolation: browser /api traffic must never reach resident services.
 * page-level contract mocks take precedence over this context-level forwarding.
 * APIRequestContext does not use browser routes: use TEST_BACKEND explicitly.
 * AGNES_TEST_BACKEND supports an independently started backend and test database.
 */
export const TEST_BACKEND = process.env.AGNES_TEST_BACKEND ?? "http://127.0.0.1:8002";
const backend = new URL(TEST_BACKEND);
const residentPorts = new Set(["8000", "8006", "4181", "4186", "4187"]);
if (backend.protocol !== "http:" || backend.hostname !== "127.0.0.1" ||
    !backend.port || residentPorts.has(backend.port) || backend.username || backend.password ||
    backend.pathname !== "/" || backend.search || backend.hash) {
  throw new Error("TEST_BACKEND must be a loopback HTTP test port, not a resident service");
}
export const test = base.extend<{ v2Isolation: void }>({
  v2Isolation: [async ({ context, page }, use) => {
    // A byte-stream relay is essential: route.fetch/fulfill buffers the full SSE
    // response and would hide all intermediate tools, progress and answer deltas.
    const relay = createServer((req, res) => {
      const cors = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "content-type,accept",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      };
      if (req.method === "OPTIONS") { res.writeHead(204, cors).end(); return; }
      const upstream = httpRequest(TEST_BACKEND + req.url, {
        method: req.method,
        headers: { ...req.headers, host: backend.host },
      }, response => {
        res.writeHead(response.statusCode ?? 502, { ...response.headers, ...cors });
        response.pipe(res);
      });
      upstream.on("error", () => { if (!res.headersSent) res.writeHead(502, cors); res.end(); });
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
    });
    await new Promise<void>(resolve => relay.listen(0, "127.0.0.1", resolve));
    const relayOrigin = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (["127.0.0.1", "localhost"].includes(url.hostname) && residentPorts.has(url.port)) {
        throw new Error("Resident services are forbidden in isolated chat tests");
      }
      if (!url.pathname.startsWith("/api/")) return route.continue();
      // The requested chat/prefill regressions do not exercise schedule writes.
      if (url.pathname === "/api/schedule") return route.abort();
      await route.continue({
        url: relayOrigin + url.pathname.replace(/^\/api/, "") + url.search,
      });
    });
    await freezeTestHmr(page);
    try { await use(); }
    finally {
      try { await context.unrouteAll({ behavior: "ignoreErrors" }); }
      finally {
        relay.closeAllConnections();
        await new Promise<void>(resolve => relay.close(() => resolve()));
      }
    }
  }, { auto: true }],
});
export { expect };
