# PageGrid responsive API

Import `PageGrid` and the exported `GridLayout`, `GridBreakpoint`, `PageGridProps` types from `src/components/PageGrid`.

```tsx
<PageGrid
  columns="minmax(0, 1fr)"
  rows="auto"
  areas={["summary", "scene", "forecast"]}
  breakpoints={[
    { minWidth: 640, columns: "minmax(0, 1fr) minmax(0, 1fr)",
      areas: ["summary summary", "scene forecast"] },
    { minWidth: 1200, columns: "minmax(0, .8fr) minmax(0, 2fr) minmax(0, 1fr)",
      rows: "minmax(min-content, 1fr)", areas: ["summary scene forecast"] },
  ]}
>
  <section style={{ gridArea: "summary" }}>…</section>
  <section style={{ gridArea: "scene" }}>…</section>
  <section style={{ gridArea: "forecast" }}>…</section>
</PageGrid>
```

- Breakpoints use **grid container width**, in CSS px, not viewport width. Native CSS container queries; no resize listeners or delayed JS layout.
- Each breakpoint may set `columns`, `rows`, `areas` (array of row strings), and `gap`. Rules cascade from smallest `minWidth` upward; omitted fields retain earlier values. `areas: []` explicitly clears areas.
- Below 640px, children automatically stack in DOM order; explicit grid areas/spans are cleared. `mobileStack={false}` opts out for nested compact grids.
- Legacy `columns`, `rows`, `className`, and children work unchanged. Use `fr`, `minmax(0, …)`, `auto` and intrinsic content sizes, not fixed dashboard heights.
- Wrapper `.page-grid-host` establishes the container, inner `.page-grid` remains the layout element. Set child `gridArea` on direct children of PageGrid. Give charts/3D explicit **responsive** minimum sizes; let cards grow with text. On narrow screens the outer page must allow vertical scrolling.
- Do not override `grid-template-*` in page CSS; use this API. Class names may style spacing/children, and `gap` can use `clamp()`.
