import { readFile } from "node:fs/promises";
import { createOpsLoader, type OpsFetch } from "../src/data/ops";
export const opsFileFetch: OpsFetch = async (url) => {
  const name = url.slice(url.lastIndexOf("/") + 1);
  const bytes = await readFile(
    new URL(`../../exports/replay/${name}`, import.meta.url),
  );
  return new Response(bytes, {
    headers: { "Content-Type": "application/json" },
  });
};
export function opsFixtureLoader() {
  return createOpsLoader({ fetch: opsFileFetch });
}
