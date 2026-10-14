import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream";
import type { Plugin } from "vite";

const types: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};
// Honor exclusions and quality values; Brotli wins an equal-quality tie.
export function acceptedEncodings(
  header: string | undefined,
): ("br" | "gzip")[] {
  if (!header) return [];
  const qualities = new Map<string, number>();
  for (const item of header.toLowerCase().split(",")) {
    const [name, ...params] = item.trim().split(";");
    const qParam = params.find((p) => p.trim().startsWith("q="));
    const q = qParam ? Number(qParam.trim().slice(2)) : 1;
    qualities.set(name, Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0);
  }
  const q = (name: string) => qualities.get(name) ?? qualities.get("*") ?? 0;
  return (["br", "gzip"] as const)
    .filter((name) => q(name) > 0)
    .sort((a, b) => q(b) - q(a));
}
export function previewCompression(): Plugin {
  return {
    name: "yunqi-preview-precompressed",
    configurePreviewServer(server) {
      const root = path.resolve(server.config.root, server.config.build.outDir);
      const base = server.config.base;
      server.middlewares.use(async (req, res, next) => {
        if (req.method !== "GET" && req.method !== "HEAD") return next();
        if (req.headers.range) return next(); // Let Vite handle identity byte ranges.
        try {
          let pathname = decodeURIComponent(
            new URL(req.url ?? "/", "http://localhost").pathname,
          );
          if (base !== "/" && base.startsWith("/")) {
            if (!pathname.startsWith(base)) return next();
            pathname = pathname.slice(base.length);
          }
          if (pathname.endsWith("/")) pathname += "index.html";
          const type = types[path.extname(pathname).toLowerCase()];
          if (!type) return next();
          const inside = (file: string) => {
            const relative = path.relative(root, file);
            return (
              relative !== "" &&
              !relative.startsWith("..") &&
              !path.isAbsolute(relative)
            );
          };
          const original = path.resolve(root, pathname.replace(/^\/+/, ""));
          if (!inside(original)) return next();
          const resolved = await realpath(original);
          if (!inside(resolved) || (await stat(resolved)).isDirectory())
            return next();
          const vary = String(res.getHeader("Vary") ?? "")
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean);
          if (
            !vary.some((v) => v.toLowerCase() === "accept-encoding") &&
            !vary.includes("*")
          )
            vary.push("Accept-Encoding");
          res.setHeader("Vary", vary.join(", "));
          let selected = resolved,
            encoding: string | undefined;
          for (const candidate of acceptedEncodings(
            req.headers["accept-encoding"],
          )) {
            const sidecar = original + (candidate === "br" ? ".br" : ".gz");
            let file: string;
            try {
              file = await realpath(sidecar);
            } catch {
              continue;
            }
            if (!inside(file)) continue;
            if (!(await stat(file)).isFile()) continue;
            selected = file;
            encoding = candidate;
            break;
          }
          const info = await stat(selected);
          const etag = `W/"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}-${encoding ?? "identity"}"`;
          res.setHeader("Content-Type", type);
          if (encoding) res.setHeader("Content-Encoding", encoding);
          if (!res.hasHeader("Cache-Control")) res.setHeader("Cache-Control", "no-cache");
          res.setHeader("ETag", etag);
          if (
            req.headers["if-none-match"]
              ?.split(",")
              .map((s) => s.trim().replace(/^W\//, ""))
              .some((value) => value === "*" || value === etag.replace(/^W\//, ""))
          ) {
            res.statusCode = 304;
            res.end();
            return;
          }
          res.setHeader("Content-Length", info.size);
          if (req.method === "HEAD") {
            res.end();
            return;
          }
          pipeline(createReadStream(selected), res, (error) => {
            if (error) res.destroy(error);
          });
          return;
        } catch {
          next();
        }
      });
    },
  };
}
