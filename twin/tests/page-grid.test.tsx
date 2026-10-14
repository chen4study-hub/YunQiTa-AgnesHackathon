import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PageGrid } from "../src/components/PageGrid";

describe("PageGrid breakpoint API", () => {
  it("preserves legacy columns/rows and defaults to mobile stacking", () => {
    const html = renderToStaticMarkup(
      <PageGrid columns="1fr 2fr" rows="auto 1fr">
        <div>A</div>
      </PageGrid>,
    );
    expect(html).toContain("--pg-columns:1fr 2fr");
    expect(html).toContain("--pg-rows:auto 1fr");
    expect(html).toContain("autoMobile");
  });
  it("sorts container breakpoints, scopes each instance and retains omitted values", () => {
    const html = renderToStaticMarkup(
      <>
        <PageGrid
          areas={["a"]}
          breakpoints={[
            { minWidth: 1200, columns: "1fr 2fr", areas: ["a b"] },
            { minWidth: 640, rows: "auto" },
          ]}
        >
          <div />
        </PageGrid>
        <PageGrid mobileStack={false}>
          <div />
        </PageGrid>
      </>,
    );
    expect(html.indexOf("min-width:640px")).toBeLessThan(
      html.indexOf("min-width:1200px"),
    );
    expect(html).toContain('--pg-areas:"a b";');
    const ids = [...html.matchAll(/data-page-grid="(pg-[^"]+)" class/g)].map(
      (match) => match[1],
    );
    expect(new Set(ids).size).toBe(2);
  });
  it("rejects invalid widths", () => {
    expect(() =>
      renderToStaticMarkup(<PageGrid breakpoints={[{ minWidth: NaN }]} />),
    ).toThrow("minWidth");
  });
});
