import { useId, type CSSProperties, type PropsWithChildren } from "react";
import { Card } from "./Card";
import styles from "./PageGrid.module.css";

export interface GridLayout {
  columns?: string;
  rows?: string;
  /** One string per row, e.g. ["metrics scene", "forecast scene"]. */
  areas?: readonly string[];
  gap?: string;
}
export interface GridBreakpoint extends GridLayout {
  /** Minimum width of this grid's container, in CSS px (not the viewport). */
  minWidth: number;
}
export interface PageGridProps extends GridLayout {
  className?: string;
  breakpoints?: readonly GridBreakpoint[];
  /** Defaults to a single column below 640px; opt out for nested micro-grids. */
  mobileStack?: boolean;
}
const areaValue = (areas?: readonly string[]) =>
  areas?.length ? areas.map((row) => `"${row}"`).join(" ") : "none";
/** Container-width breakpoints cascade upward, retaining omitted properties. */
export function PageGrid({
  children,
  columns = "minmax(0, 1fr)",
  rows = "1fr",
  areas,
  gap,
  className = "",
  breakpoints = [],
  mobileStack = true,
}: PropsWithChildren<PageGridProps>) {
  const id = `pg-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const rules = [...breakpoints]
    .sort((a, b) => a.minWidth - b.minWidth)
    .map((layout) => {
      if (!Number.isFinite(layout.minWidth) || layout.minWidth < 0)
        throw new Error(
          "PageGrid minWidth must be a non-negative finite number",
        );
      const declarations = [
        layout.columns === undefined ? "" : `--pg-columns:${layout.columns};`,
        layout.rows === undefined ? "" : `--pg-rows:${layout.rows};`,
        layout.areas === undefined
          ? ""
          : `--pg-areas:${areaValue(layout.areas)};`,
        layout.gap === undefined ? "" : `--pg-gap:${layout.gap};`,
      ].join("");
      return `@container pagegrid (min-width:${layout.minWidth}px){[data-page-grid="${id}"]{${declarations}}}`;
    })
    .join("\n");
  return (
    <div
      className={`page-grid-host ${styles.host}`}
      style={
        {
          "--pg-columns": columns,
          "--pg-rows": rows,
          "--pg-areas": areaValue(areas),
          ...(gap ? { "--pg-gap": gap } : {}),
        } as CSSProperties
      }
    >
      {rules && <style>{rules}</style>}
      <div
        data-page-grid={id}
        className={`page-grid ${styles.grid} ${mobileStack ? styles.autoMobile : ""} ${className}`}
      >
        {children}
      </div>
    </div>
  );
}
export function PlaceholderCard({
  title,
  description = "模块占位 · 等待接入",
  children,
  style,
  className = "",
}: PropsWithChildren<{
  title: string;
  description?: string;
  style?: CSSProperties;
  className?: string;
}>) {
  return (
    <div className={`placeholder-slot ${className}`} style={style}>
      <Card label={title}>
        <h2>{title}</h2>
        <small>{description}</small>
        {children ?? <div className="placeholder-surface">{title} · 占位</div>}
      </Card>
    </div>
  );
}
