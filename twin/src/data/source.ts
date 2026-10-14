import { ApiAdapter, MockAdapter, ReplayFileAdapter } from "./adapters";
import type { TwinDataSource } from "./types";

export type SourceKind = "file" | "api" | "mock";
export function createSource(query: string): TwinDataSource {
  const params = new URLSearchParams(query);
  const kind = params.get("source");
  const source =
    kind === "mock"
      ? new MockAdapter()
      : kind === "api"
        ? new ApiAdapter(params.get("api") ?? "/api")
        : new ReplayFileAdapter();
  return source;
}
/** Compatibility for existing callers; errors must propagate, never become mocks. */
export function withFallback(source: TwinDataSource): TwinDataSource {
  return source;
}
