import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDataManifest } from "../scripts/dataManifest";
import type { Page } from "@playwright/test";
/** Advertise exactly the replacement bytes to the production versioned cache. */
export async function serveDataOverrides(
  page: Page,
  files: Record<string, Buffer>,
) {
  await page.route(
    (url) => url.pathname.endsWith("/data-manifest.json"),
    async (r) => {
      const manifest = await createDataManifest(
        fileURLToPath(new URL("../public/replay/", import.meta.url)),
      );
      for (const [name, bytes] of Object.entries(files))
        manifest.files[name] = {
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.length,
        };
      await r.fulfill({ json: manifest });
    },
  );
  await page.route(
    (url) =>
      Object.keys(files).some((name) =>
        url.pathname.endsWith(`/replay/${name}`),
      ),
    (r) => {
      const name = Object.keys(files).find((name) =>
        new URL(r.request().url()).pathname.endsWith(`/replay/${name}`),
      )!;
      return r.fulfill({ body: files[name], contentType: "application/json" });
    },
  );
}
