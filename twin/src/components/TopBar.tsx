import shell from "./DashboardShell.module.css";
import { pages, formatDisplayDate } from "../config/presentation";
import { useDashboard } from "../state/context";
import type { Page } from "../state/store";
import { prefetchPage } from "../config/pageRoutes";

export function TopBar({
  onNavigate,
  pendingPage = null,
}: {
  onNavigate?: (page: Page) => void;
  pendingPage?: Page | null;
}) {
  const { state, store } = useDashboard();
  const prefetch = (page: Page) => {
    void prefetchPage(page).catch(() => {});
  };
  return (
    <header className={`topbar ${shell.top}`}>
      <div className="brand">
        <img
          className="yunqi-logo top-logo"
          src={`${import.meta.env.BASE_URL}brand/yunqi-tower.svg`}
          alt="云栖塔"
        />
        <span>能耗数字孪生</span>
      </div>
      <nav className="shell-navigation" aria-label="页面导航">
        {pages.map((page) => (
          <button
            key={page.id}
            className={`nav-item ${state.page === page.id ? "active" : ""}`}
            aria-pressed={state.page === page.id}
            onClick={() =>
              onNavigate ? onNavigate(page.id) : store.setPage(page.id)
            }
            onMouseEnter={() => prefetch(page.id)}
            onFocus={() => prefetch(page.id)}
            aria-busy={pendingPage === page.id}
            data-page-link={page.id}
          >
            {page.label}
            <small>{page.english}</small>
          </button>
        ))}
      </nav>
      <time className={shell.currentDate} aria-label="当前本地日期">
        {formatDisplayDate(state.nowMs)}
      </time>
      <span className="top-badge green">
        <i />
        系统运行中 LIVE
      </span>
      <span className="top-badge cyan">自动调度 · 低置信度转人工</span>
    </header>
  );
}
