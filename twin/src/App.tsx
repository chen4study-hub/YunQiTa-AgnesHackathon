import {
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useTransition,
  useCallback,
  memo,
  useImperativeHandle,
  type Ref,
} from "react";
import shell from "./components/DashboardShell.module.css";
import { ScaleViewport } from "./components/ScaleViewport";
import { TopBar } from "./components/TopBar";
import { BottomBar } from "./components/BottomBar";
import { OverviewPage } from "./pages/OverviewPage";
import { pageRegistry } from "./config/pageRoutes";
import { PageErrorBoundary } from "./components/PageErrorBoundary";
import { StoreContext, useDashboard } from "./state/context";
import type { DashboardStore, Page } from "./state/store";
type NavigationHandle = { navigate: (page: Page) => void };
const PageOutlet = memo(function PageOutlet({
  navigation,
  onCommit,
  onPending,
}: {
  navigation: Ref<NavigationHandle>;
  onCommit: (page: Page) => void;
  onPending: (page: Page | null) => void;
}) {
  const [route, setRoute] = useState<Page>("overview");
  const [requested, setRequested] = useState<Page>("overview");
  const [pending, startNavigation] = useTransition();
  useImperativeHandle(
    navigation,
    () => ({
      navigate(page) {
        setRequested(page);
        startNavigation(() => setRoute(page));
      },
    }),
    [],
  );
  useEffect(
    () => onPending(pending ? requested : null),
    [pending, requested, onPending],
  );
  const SelectedPage = pageRegistry[route];
  return (
    <Suspense fallback={null}>
      <div
        className={`overview-persistent ${shell.slot}`}
        hidden={route !== "overview"}
      >
        <PageErrorBoundary>
          <OverviewPage />
        </PageErrorBoundary>
      </div>
      {route !== "overview" && (
        <div className={shell.slot} key={route}>
          <PageErrorBoundary key={route}>
            <SelectedPage />
          </PageErrorBoundary>
        </div>
      )}
      <PageCommit page={route} onCommit={onCommit} />
    </Suspense>
  );
});
function PageCommit({
  page,
  onCommit,
}: {
  page: Page;
  onCommit: (page: Page) => void;
}) {
  useLayoutEffect(() => onCommit(page), [page, onCommit]);
  return null;
}

function Frame() {
  const { state, store } = useDashboard();
  const navigation = useRef<NavigationHandle>(null);
  const [pendingPage, setPendingPage] = useState<Page | null>(null);
  const navigate = (page: Page) => navigation.current?.navigate(page);
  const commitPage = useCallback(
    (page: Page) => {
      if (store.getSnapshot().page !== page) store.setPage(page);
    },
    [store],
  );
  // Passive on playback/fractional seek; one cached current-origin schedule shared across pages.
  useEffect(() => {
    if (state.page === "overview" || state.page === "agent")
      void store.ensureLiveSchedule();
  }, [
    store,
    state.page,
    state.data,
    state.scenario,
    state.time,
    state.hour,
    state.loading,
    state.playing,
  ]);
  const content = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const main = content.current;
    if (!main) return;
    // Shared scroll policy: only intrinsically growing record/dialog regions.
    const mark = () =>
      main
        .querySelectorAll<HTMLElement>(
          ".agent-chat-messages, .agent-table-scroll, .agent-workflow-body, .agent-receipt, .agent-plan-column, .agent-steps, .energy-table-scroll, .floors-lift-scroll, .floors-load-scroll, .forecast-table-scroll",
        )
        .forEach((element) => {
          if (!element.hasAttribute("data-scroll-region"))
            element.setAttribute("data-scroll-region", "records");
        });
    mark();
    const observer = new MutationObserver((records) => {
      if (
        records.some((record) =>
          Array.from(record.addedNodes).some(
            (node) => node.nodeType === Node.ELEMENT_NODE,
          ),
        )
      )
        mark();
    });
    observer.observe(main, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [state.page]);
  return (
    <ScaleViewport>
      <div className={`dashboard responsive-dashboard ${shell.shell}`}>
        <TopBar onNavigate={navigate} pendingPage={pendingPage} />
        <main
          ref={content}
          className={`page-content ${shell.content}`}
          data-page={state.page}
          data-page-pending={pendingPage ?? undefined}
          aria-label="页面内容"
          aria-busy={state.loading}
        >
          {state.loadError ? (
            <div role="alert" style={{ fontSize: "var(--font-body)", padding: "var(--space)" }}>
              <p>数据暂不可用</p>
              <button type="button" style={{ fontSize: "var(--font-body)" }} onClick={() => void store.retryLoad()}>重试</button>
            </div>
          ) : <PageOutlet
            navigation={navigation}
            onCommit={commitPage}
            onPending={setPendingPage}
          />}
        </main>
        <BottomBar />
      </div>
    </ScaleViewport>
  );
}
export function App({ store }: { store: DashboardStore }) {
  useEffect(() => {
    void store.initialize();
    return () => store.dispose();
  }, [store]);
  return (
    <StoreContext.Provider value={store}>
      <Frame />
    </StoreContext.Provider>
  );
}
