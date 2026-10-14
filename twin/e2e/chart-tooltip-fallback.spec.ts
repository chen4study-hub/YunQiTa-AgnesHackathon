import { test, expect } from "@playwright/test";

for (const width of [390, 1920])
  test(`EChart canvas fallback and overview title font ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1080 });
    await page.route("**/api/**", (route) => route.abort());
    await page.goto("/?source=file&at=2026-10-12T18:00");
    await expect(page.locator(".agent-verdict h2")).toHaveText("Agent 结论");
    const font = await page
      .locator(".agent-verdict h2")
      .evaluate((el) => getComputedStyle(el).fontFamily);
    expect(font).toContain("Microsoft YaHei");
    expect(font).toContain("sans-serif");
    expect(font).not.toMatch(/Mono|Barlow/);
    const mainSource = await (await page.request.get("/src/main.tsx")).text();
    const chartSource = await (
      await page.request.get("/src/components/EChart.tsx")
    ).text();
    const react =
      mainSource.match(/from ["']([^"']*react\.js[^"']*)["']/)?.[1] ??
      (await (await page.request.get("/src/App.tsx")).text()).match(
        /from ["']([^"']*react\.js[^"']*)["']/,
      )![1];
    const dom = mainSource.match(
      /from ["']([^"']*react-dom_client\.js[^"']*)["']/,
    )![1];
    const ec = chartSource.match(/from ["']([^"']*echarts\.js[^"']*)["']/)![1];
    await page.evaluate(
      async ({ react, dom, ec }) => {
        const reactModule = await import(/* @vite-ignore */ react);
        const React = reactModule.default ?? reactModule;
        const domModule = await import(/* @vite-ignore */ dom);
        const { createRoot } = domModule.default ?? domModule;
        const { EChart } = await import(
          /* @vite-ignore */ "/src/components/EChart.tsx"
        );
        const echarts = await import(/* @vite-ignore */ ec);
        const host = document.createElement("div");
        host.id = "fallback-fixture";
        Object.assign(host.style, {
          position: "fixed",
          top: "0",
          left: "0",
          width: "360px",
          height: "260px",
          zIndex: "100",
          background: "#111b25",
        });
        document.body.append(host);
        const original = CanvasRenderingContext2D.prototype.fillText;
        (window as any).fallbackTexts = [];
        CanvasRenderingContext2D.prototype.fillText = function (
          ...args: Parameters<typeof original>
        ) {
          if (this.canvas.closest("#fallback-fixture"))
            (window as any).fallbackTexts.push(String(args[0]));
          return original.apply(this, args);
        };
        const root = createRoot(host);
        (window as any).fallbackFixture = {
          root,
          React,
          EChart,
          echarts,
          render: (mode: string, phased: boolean) =>
            root.render(
              React.createElement(EChart, {
                label: "fallback fixture",
                phased,
                option: {
                  animation: !phased,
                  grid: { left: 50, right: 20, top: 40, bottom: 40 },
                  xAxis: {
                    type: "value",
                    min: 0,
                    max: 24,
                    interval: 6,
                    axisLabel: {
                      formatter: (h: number) =>
                        h === 24
                          ? "次日 00:00"
                          : `${String(h).padStart(2, "0")}:00`,
                    },
                  },
                  yAxis: { type: "value" },
                  tooltip:
                    mode === "custom"
                      ? { formatter: () => "自定义 0.82 元/kWh" }
                      : mode === "price"
                        ? {
                            valueFormatter: (v: number) =>
                              v.toFixed(2) + " 元/kWh",
                          }
                        : {},
                  series: [
                    {
                      id: "fixture",
                      type: "line",
                      name: "数值",
                      data: [
                        [18, mode === "price" ? 0.819 : 1381.5224997184777],
                      ],
                    },
                  ],
                },
              }),
            ),
        };
        (window as any).fallbackFixture.render("default", false);
      },
      { react, dom, ec },
    );
    await expect(
      page.getByRole("img", { name: "fallback fixture" }),
    ).toBeVisible();
    for (const mode of ["default", "price", "custom"]) {
      await page.evaluate(
        (mode) =>
          (window as any).fallbackFixture.render(mode, mode === "price"),
        mode,
      );
      await page.waitForTimeout(250);
      await page.evaluate(() => {
        const f = (window as any).fallbackFixture;
        const chart = f.echarts.getInstanceByDom(
          document.querySelector("#fallback-fixture .echart"),
        );
        chart.dispatchAction({ type: "hideTip" });
        (window as any).fallbackTexts = [];
        chart.dispatchAction({ type: "showTip", seriesIndex: 0, dataIndex: 0 });
      });
      await expect
        .poll(() =>
          page.evaluate(() => (window as any).fallbackTexts.join("\n")),
        )
        .toContain(mode === "default" ? "1,381.5" : "0.82 元/kWh");
      const texts: string[] = await page.evaluate(
        () => (window as any).fallbackTexts,
      );
      if (mode !== "custom") expect(texts).toContain("18:00");
      expect(texts).not.toContain("18.00");
      expect(texts.join("\n")).not.toMatch(/\d+\.\d{3,}/);
      if (mode === "custom") expect(texts.join("\n")).toContain("自定义");
    }
    await page.evaluate(() => {
      (window as any).fallbackFixture.root.unmount();
      document.getElementById("fallback-fixture")?.remove();
    });
  });
