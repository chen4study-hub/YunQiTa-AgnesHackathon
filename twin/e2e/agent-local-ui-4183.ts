import type { Page } from "@playwright/test";
/** Use current Vite UI on 4183, leaving /api on the real authorized test database. Never overwrite or restart its fixed deployment. */
export async function currentUI4183(page: Page) {
  if (process.env.AGENT_UI_ORIGIN === "")
    throw new Error("AGENT_UI_ORIGIN required");
  if (!process.env.AGENT_UI_ORIGIN) return;
  const source = new URL(process.env.AGENT_UI_ORIGIN);
  if (source.hostname !== "127.0.0.1") throw new Error("Local UI only");
  await page.route("http://127.0.0.1:4183/**", async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith("/api/")) return route.continue();
    const response = await route.fetch({
      url: new URL(u.pathname + u.search, source).href,
    });
    const headers = { ...response.headers() };
    delete headers["content-length"];
    delete headers["content-encoding"];
    await route.fulfill({ response, headers });
  });
}
