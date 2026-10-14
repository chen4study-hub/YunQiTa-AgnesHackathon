import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { createDataManifest } from "../scripts/dataManifest";
import { fileURLToPath } from "node:url";
/** Browser exercises the production loader against real repository export bytes. */
export async function serveOps(
  page: Page,
  overrides: Record<string, Buffer> = {},
) {
  // Replacement bytes and their advertised SHA must be a single fixture.
  // Keep non-Ops entries bound to public files: replay still loads normally.
  await page.route(
    (url) => url.pathname.endsWith("/data-manifest.json"),
    async (route) => {
      const manifest = await createDataManifest(
        fileURLToPath(new URL("../public/replay/", import.meta.url)),
      );
      const exports = await createDataManifest(
        fileURLToPath(new URL("../../exports/replay/", import.meta.url)),
      );
      for (const [name, entry] of Object.entries(exports.files)) {
        if (name === "ops-calendar.json" || /\.ops[^/]*\.json$/.test(name))
          manifest.files[name] = entry;
      }
      for (const [name, bytes] of Object.entries(overrides))
        manifest.files[name] = {
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.length,
        };
      await route.fulfill({ json: manifest });
    },
  );
  await page.route(
    (url) => /\/replay\/[^/]+\.ops[^/]*\.json$/.test(url.pathname),
    async (route) => {
      const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
      await route.fulfill({
        body:
          overrides[name] ??
          (await readFile(
            new URL(`../../exports/replay/${name}`, import.meta.url),
          )),
        contentType: "application/json",
      });
    },
  );
  await page.route(
    (url) => url.pathname.endsWith("/replay/ops-calendar.json"),
    async (route) => {
      await route.fulfill({
        body:
          overrides["ops-calendar.json"] ??
          (await readFile(
            new URL("../../exports/replay/ops-calendar.json", import.meta.url),
          )),
        contentType: "application/json",
      });
    },
  );
}
