import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Card } from "../src/components/Card";
import { Title } from "../src/components/Title";
import { DataSourceTag } from "../src/components/DataSourceTag";
import { Button } from "../src/components/Button";
import { Table } from "../src/components/Table";
import { ValueCell } from "../src/components/ValueCell";
import { darkTheme } from "../src/ui/chartTheme";
import { sampleChart } from "../src/ui/sampleChart";

describe("K02 reusable components", () => {
  it("preserves supplied content regardless of card class names", () => {
    const html = renderToStaticMarkup(
      <Card className="overview-forecast">
        <h2>24 小时预测</h2>
        <small>最近 2 点实测 + 未来 24 点预测 · 契约 1.3</small>
        <div data-chart="kept" />
      </Card>,
    );
    expect(html).toContain("最近 2 点实测 + 未来 24 点预测");
    expect(html).toContain("契约 1.3");
    expect(html).toContain('data-chart="kept"');
    expect(
      renderToStaticMarkup(
        <Card>
          <small>原始说明</small>
        </Card>,
      ),
    ).toContain("原始说明");
  });
  it("composes title and data source without HTML injection", () => {
    const html = renderToStaticMarkup(
      <Card>
        <Title
          subtitle="ENVIRONMENT"
          trailing={<DataSourceTag name="IoT 传感" />}
        >
          {"<script>"}
        </Title>
      </Card>,
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("LIVE · 已接入");
    expect(html).toContain("card-heading");
  });
  it("formats value units and button defaults", () => {
    expect(
      renderToStaticMarkup(<ValueCell label="负荷" value="2,589" unit="kW" />).replace(/\u00a0/g, " "),
    ).toContain(" kW");
    const html = renderToStaticMarkup(<Button variant="primary">查看</Button>);
    expect(html).toContain('type="button"');
    expect(html).toContain("button-primary");
    const metric = renderToStaticMarkup(
      <ValueCell
        label="负荷"
        value="2,589"
        unit="kW"
        note="当前值"
        size="large"
      />,
    );
    expect(metric).toContain("type-number-lg");
    expect(metric).toContain("unit type-unit");
    expect(metric).toContain("type-note");
  });
  it("renders semantic table headings", () => {
    const html = renderToStaticMarkup(
      <Table label="告警" headers={["时间"]} rows={[["14:00"]]} />,
    );
    expect(html).toContain('scope="col"');
    expect(html).toContain("14:00");
  });
  it("uses safe dark chart theme and interval series", () => {
    expect(darkTheme.tooltip.renderMode).toBe("richText");
    expect(darkTheme.backgroundColor).toBe("transparent");
    expect(sampleChart.series).toHaveLength(4);
  });
});
