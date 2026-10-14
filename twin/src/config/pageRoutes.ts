import { lazy, type ComponentType } from "react";
import { OverviewPage } from "../pages/OverviewPage";
import type { Page } from "../state/store";

type PageModule = { default: ComponentType };
type DeferredPage = Exclude<Page, "overview">;
const loaders: Record<DeferredPage, () => Promise<PageModule>> = {
  forecast: () =>
    import("../pages/ForecastPage").then((m) => ({ default: m.ForecastPage })),
  agent: () =>
    import("../pages/AgentPage").then((m) => ({ default: m.AgentPage })),
  floors: () =>
    import("../pages/FloorsPage").then((m) => ({ default: m.FloorsPage })),
  energy: () =>
    import("../pages/EnergyPage").then((m) => ({ default: m.EnergyPage })),
  about: () =>
    import("../pages/AboutPage").then((m) => ({ default: m.AboutPage })),
};
const requests = new Map<DeferredPage, Promise<PageModule>>();
function loadPage(page: DeferredPage) {
  let request = requests.get(page);
  if (!request) {
    request = loaders[page]();
    requests.set(page, request);
    // A failed hover prefetch may be retried by a later navigation.
    void request.catch(() => {
      if (requests.get(page) === request) requests.delete(page);
    });
  }
  return request;
}
/** Explicit navigation intent only: no idle/timer prefetch of other pages. */
export function prefetchPage(page: Page): Promise<unknown> {
  return page === "overview" ? Promise.resolve() : loadPage(page);
}
export const pageRegistry: Record<Page, ComponentType> = {
  overview: OverviewPage,
  forecast: lazy(() => loadPage("forecast")),
  agent: lazy(() => loadPage("agent")),
  floors: lazy(() => loadPage("floors")),
  energy: lazy(() => loadPage("energy")),
  about: lazy(() => loadPage("about")),
};
