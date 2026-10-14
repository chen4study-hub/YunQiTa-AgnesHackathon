import React from "react";
import { createRoot } from "react-dom/client";
import { PageGrid } from "../../src/components/PageGrid";
import { Table } from "../../src/components/Table";
import "../../src/ui/styles.css";
import "../../src/ui/responsive.css";
createRoot(document.getElementById("root")!).render(
  <div id="container" style={{ width: "100%" }}>
    <PageGrid
      columns="1fr"
      rows="auto"
      areas={["a", "b", "c"]}
      breakpoints={[
        { minWidth: 640, columns: "1fr 1fr", areas: ["a a", "b c"] },
        { minWidth: 1200, columns: "1fr 2fr 1fr", areas: ["a b c"] },
      ]}
    >
      {["a", "b", "c"].map((area) => (
        <section
          key={area}
          data-area={area}
          style={{ gridArea: area, padding: "1rem" }}
        >
          {area}
        </section>
      ))}
    </PageGrid>
    <div className="card" style={{ width: "100%" }}>
      <Table
        label="滚动表格测试"
        headers={["列一", "列二", "列三", "列四"]}
        rows={[[...Array.from({ length: 4 }, () => "宽表格内容 123456789")]]}
      />
    </div>
  </div>,
);
