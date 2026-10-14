import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { compression, defineAlgorithm } from "vite-plugin-compression2";
import { previewCompression } from "./scripts/previewCompression.ts";
import { dataManifest } from "./scripts/dataManifest.ts";
const repositoryDirectory = fileURLToPath(new URL(".", import.meta.url));
// Source archives and machines without Git are supported in both serve and build.
const suppliedRevision = process.env.VITE_GIT_COMMIT?.trim() ?? "";
let revision: string | null = /^[a-f0-9]{7,40}$/i.test(suppliedRevision)
  ? suppliedRevision.slice(0, 7).toLowerCase()
  : null;
if (!revision)
  try {
    const hash = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
      cwd: repositoryDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (/^[a-f0-9]{7,40}$/.test(hash)) revision = hash;
  } catch {
    /* A source archive has no revision; provenance stays explicitly null. */
  }
const buildTime = new Date().toISOString();

const apiProxy = {
  "/api": {
    target: "http://127.0.0.1:8000",
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api(?=\/|$)/, "") || "/",
  },
};

export default defineConfig({
  plugins: [
    react(),
    dataManifest(),
    previewCompression(),
    {
      // Favicons use a separate browser fetch context; inline the generated mark
      // so the header remains the sole external brand image on the first screen.
      name: "yunqi-inline-favicon",
      transformIndexHtml(html) {
        const svg = readFileSync(
          new URL("./public/brand/yunqi-tower-mark.svg", import.meta.url),
        );
        return html.replace(
          'href="/brand/yunqi-tower-mark.svg"',
          `href="data:image/svg+xml;base64,${svg.toString("base64")}"`,
        );
      },
    },
    {
      name: "yunqi-build-provenance",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "build-info.json",
          source: JSON.stringify({ revision, buildTime }),
        });
      },
    },
    compression({
      include: /\.(js|mjs|css|json|html|svg)$/i,
      threshold: 0,
      skipIfLargerOrEqual: false,
      deleteOriginalAssets: false,
      algorithms: [defineAlgorithm("gzip", { level: 9 }), "brotliCompress"],
    }),
  ],
  define: {
    "import.meta.env.VITE_BUILD_TIME": JSON.stringify(buildTime),
    __BUILD_REVISION__: JSON.stringify(revision),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
  server: { proxy: apiProxy },
  preview: { proxy: apiProxy },
  build: { rolldownOptions: { input: ["index.html", "showcase.html"] } },
});
