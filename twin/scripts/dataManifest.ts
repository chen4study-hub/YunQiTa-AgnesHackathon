import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Plugin } from "vite";

export const MANIFEST_FILE = "data-manifest.json";
export async function createDataManifest(directory: string) {
  const files: Record<string, { sha256: string; bytes: number }> = {};
  async function walk(dir: string) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && entry.name.endsWith(".json")) {
        const bytes = await readFile(file);
        files[path.relative(directory, file).split(path.sep).join("/")] = {
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.length,
        };
      }
    }
  }
  await walk(directory);
  return { schemaVersion: 1 as const, files };
}
export function dataManifest(): Plugin {
  let publicDirectory: string;
  return {
    name: "yunqi-data-manifest",
    configResolved(config) {
      publicDirectory = config.publicDir;
    },
    async generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: MANIFEST_FILE,
        source: JSON.stringify(
          await createDataManifest(path.join(publicDirectory, "replay")),
        ),
      });
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        if (
          pathname !== `${server.config.base}${MANIFEST_FILE}` ||
          !["GET", "HEAD"].includes(req.method ?? "")
        )
          return next();
        try {
          const body = JSON.stringify(
            await createDataManifest(path.join(publicDirectory, "replay")),
          );
          const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("ETag", etag);
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          if (
            req.headers["if-none-match"]
              ?.split(",")
              .some(
                (value) =>
                  value.trim().replace(/^W\//, "") === etag ||
                  value.trim() === "*",
              )
          ) {
            res.statusCode = 304;
            res.end();
            return;
          }
          res.end(req.method === "HEAD" ? undefined : body);
        } catch (error) {
          next(error);
        }
      });
    },
    configurePreviewServer(server) {
      // Installed before compression/static serving, including binary/font assets.
      server.middlewares.use((req, res, next) => {
        let pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        const base = server.config.base;
        if (!pathname.startsWith(base)) return next();
        pathname = pathname.slice(base.length);
        if (/^assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9.]+$/i.test(pathname))
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        else if (
          pathname === MANIFEST_FILE ||
          pathname.startsWith("replay/") ||
          pathname.endsWith(".html") ||
          !path.extname(pathname)
        )
          res.setHeader("Cache-Control", "no-cache");
        next();
      });
    },
  };
}
