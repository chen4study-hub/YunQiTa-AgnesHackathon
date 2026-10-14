import { expect, test } from "@playwright/test";
import { opsFloorScale, sampleOpsFloorLoads } from "../src/data/ops";
import { floorColor } from "../src/ui/floorColors";
import { isolateOpsTest, opsDay } from "./ops-test-data";

for (const date of ["2026-10-12", "2026-07-23", "2026-10-01"]) {
  test(`floors and 3D share interpolated ops colors ${date}`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    await isolateOpsTest(page);
    const day = opsDay(date),
      scale = opsFloorScale(day);
    expect(opsFloorScale(day)).toBe(scale);
    for (const time of ["10:00", "14:30", "23:00"]) {
      const at = Date.parse(`${date}T${time}:00`),
        loads = sampleOpsFloorLoads(day, at);
      const colors = loads.map((load, index) =>
        floorColor(
          load,
          scale,
          day.hours[0].floors.find((f) => f.floor === index + 1)!.use,
        ),
      );
      await page.goto(`/?source=file&at=${date}T${time}`, {
        waitUntil: "domcontentloaded",
      });
      const snap = async () =>
        JSON.parse(
          (await page.locator(".twin-scene").getAttribute("data-scene")) ??
            "{}",
        );
      await expect.poll(async () => (await snap()).opsAvailable).toBe(true);
      await expect
        .poll(async () => (await snap()).floorActualLoads)
        .toEqual(loads);
      expect((await snap()).floorColorScale).toEqual(scale);
      expect(
        (await snap()).floorTargetColors.map(
          (c: string) => `#${c.toUpperCase()}`,
        ),
      ).toEqual(
        date === "2026-10-01" &&
          Number(time.slice(0, 2)) >= 8 &&
          Number(time.slice(0, 2)) < 20
          ? colors.map((color, index) =>
              day.hours[0].floors.find((f) => f.floor === index + 1)!.use ===
              "equipment"
                ? color
                : "#E66B78",
            )
          : colors,
      );
      // The overview's existing whole-building alert overlay is not a load color.
      // Floor bars always show the public actual-load palette underneath it.
      await page.getByRole("button", { name: "楼层与电梯" }).click();
      const chart = page.locator(".floors-load-chart");
      await expect(chart).toHaveAttribute(
        "data-color-scale",
        JSON.stringify(scale),
      );
      const source = await (
        await page.request.get("/src/pages/energy/SmoothChart.tsx")
      ).text();
      const moduleUrl = source.match(
        /from ["']([^"']*echarts\.js[^"']*)["']/,
      )![1];
      await expect
        .poll(async () =>
          chart.evaluate(async (e, url) => {
            const ec = await import(/* @vite-ignore */ url);
            return ec
              .getInstanceByDom(e)
              .getOption()
              .series[0].data.map((row: any) => ({
                value: row.value,
                color: row.itemStyle.color,
              }));
          }, moduleUrl),
        )
        .toEqual(
          loads.map((value, index) => ({ value, color: colors[index] })),
        );
      expect(
        await chart.evaluate(async (e, url) => {
          const ec = await import(/* @vite-ignore */ url);
          const formatter = ec.getInstanceByDom(e).getOption().series[0]
            .label.formatter;
          return [33, 28, 29.2, 1234].map((value) => formatter({ value }));
        }, moduleUrl),
      ).toEqual(["33.0", "28.0", "29.2", "1,234.0"]);
      const legend = await page.locator(".floors-load-legend").innerText();
      for (const value of [scale.p10, scale.p50, scale.p90])
        expect(legend).toContain(
          value.toLocaleString("en-US", {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
          }),
        );
    }
  });
}
