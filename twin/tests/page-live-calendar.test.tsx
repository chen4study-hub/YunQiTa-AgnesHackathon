import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useSyncExternalStore: (
      subscribe: Parameters<typeof actual.useSyncExternalStore>[0],
      snapshot: () => unknown,
    ) => actual.useSyncExternalStore(subscribe, snapshot, snapshot),
  };
});
import { EnergyPage } from "../src/pages/EnergyPage";
import { FloorsPage } from "../src/pages/FloorsPage";
import { DashboardStore } from "../src/state/store";
import { StoreContext } from "../src/state/context";
import { MockAdapter } from "../src/data/adapters";
import type { ReplayData } from "../src/data/types";
import { formatDisplayDate } from "../src/config/presentation";

describe("local-calendar page presentation", () => {
  for (const scenario of ["normal", "peak", "abstain"] as const) {
    it(`${scenario}: neither page displays representative-scenario wording`, async () => {
      const data: ReplayData = JSON.parse(
        readFileSync(`public/replay/${scenario}.json`, "utf8"),
      );
      const source = new MockAdapter();
      source.loadScenario = async () => data;
      const store = new DashboardStore(source, async () => null, {
        query: `?scenario=${scenario}&at=2026-10-12T14:00`,
      });
      await store.initialize();
      try {
        for (const Page of [EnergyPage, FloorsPage]) {
          const html = renderToStaticMarkup(
            <StoreContext.Provider value={store}>
              <Page />
            </StoreContext.Provider>,
          );
          const visible = html.replace(/<[^>]*>/g, " ");
          expect(visible).not.toMatch(/典型日|情景|代表日|高温日|节假日/);
          expect(html).toContain(
            `data-date="${formatDisplayDate(store.getSnapshot().nowMs)}"`,
          );
          expect(html).not.toContain(data.meta.date);
        }
      } finally {
        store.dispose();
      }
    });
  }
});
