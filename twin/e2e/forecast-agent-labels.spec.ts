import { DESKTOP_125 } from "./viewport-profile";
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
for (const size of [
  { width: 1366, height: 768, dpr: 1 },
  DESKTOP_125,
  { width: 1920, height: 1080, dpr: 1 },
  { width: 390, height: 844, dpr: 1 },
])
  test.describe(`label clarity ${size.width}`, () => {
    test.use({ viewport: size, deviceScaleFactor: size.dpr });
    test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test("time label avoids axis/peak; current upper and exported explanation/source tooltip stay clear", async ({
      page,
    }, info) => {
      const data = JSON.parse(
        readFileSync("public/replay/normal.json", "utf8"),
      );

      await page.route("**/api/**", (r) => r.abort());
      await page.goto("/?source=file&scenario=normal&at=2026-10-12T14:00");
      await page.getByRole("button", { name: "预测与风险" }).click();
      const host = page.locator(".forecast-window-plot");
      await expect(host).toHaveAttribute("_echarts_instance_", /./);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(300);
      const read = () =>
        host.evaluate(async (el) => {
          const source = await (
            await fetch("/src/pages/forecast/Plot.tsx")
          ).text();
          const url = source.match(
            /from\s+["']([^"']*\/echarts\.js[^"']*)["']/,
          )![1];
          const e = await import(url),
            chart = e.getInstanceByDom(el);
          const texts = chart
            .getZr()
            .storage.getDisplayList()
            .filter((n: any) =>
              ["t · 14:00", "负荷 / kW", "峰值"].includes(n.style?.text),
            )
            .map((n: any) => {
              const r = n.getBoundingRect().clone();
              r.applyTransform(n.getComputedTransform());
              return {
                text: n.style.text,
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
              };
            });
          return {
            texts,
            height: chart.getHeight(),
            width: chart.getWidth(),
            mark: chart
              .getOption()
              .series.find((s: any) => s.id === "forecast-actual").markLine
              .data,
          };
        });
      const before = await read(),
        label = before.texts.find((t: any) => t.text === "t · 14:00")!;
      expect(label).toBeTruthy();
      const overlap = (a: any, b: any) =>
        a.x < b.x + b.width &&
        a.x + a.width > b.x &&
        a.y < b.y + b.height &&
        a.y + a.height > b.y;
      for (const text of before.texts.filter(
        (t: any) => t.text !== "t · 14:00",
      ))
        expect(overlap(label, text), JSON.stringify(before)).toBe(false);
      expect(label.y).toBeGreaterThan(before.height / 2);
      expect(label.y + label.height).toBeLessThan(before.height);
      expect(label.x + label.width).toBeLessThan(before.width);
      await info.attach("forecast-static", {
        body: await page.screenshot({
          path: info.outputPath("forecast-static.png"),
        }),
        contentType: "image/png",
      });
      await page.getByRole("button", { name: "▶ 播放", exact: true }).click();
      await page.waitForTimeout(200);
      await page.getByRole("button", { name: "Ⅱ 暂停", exact: true }).click();
      const playing = await read();
      expect(playing.mark).toEqual([]);
      expect(playing.texts.some((t: any) => t.text === "t · 14:00")).toBe(
        false,
      );
      await expect(page.locator(".forecast-window-playhead")).toBeVisible();
      await info.attach("forecast-playing", {
        body: await page.screenshot({
          path: info.outputPath("forecast-playing.png"),
        }),
        contentType: "image/png",
      });
      await page.goto("/?source=file&scenario=normal&at=2026-10-12T14:00");
      await page.getByRole("button", { name: "Agent 决策" }).click();
      const metric = page.locator(".agent-plan li").first();
      await expect(metric).toContainText("当前小时区间上界");
      await expect(metric).toContainText(
        data.hours[14].upper_kw.toLocaleString("en-US", {
          maximumFractionDigits: 1,
        }),
      );
      await expect(page.locator(".agent-reason-preview")).toContainText(
        data.hours[14].agent.explanation.split("。")[0],
      );
      const subtitle = page
        .locator(".agent-decision-card > .agent-heading > div > small")
        .first();
      await expect(subtitle).toContainText("LLM 决策");
      await expect(page.locator(".agent-decision-source")).toHaveAttribute(
        "title",
        "模板措辞",
      );
      await page.locator(".agent-decision-source").hover();
      await expect(page.locator(".agent-root")).not.toContainText(
        /模板措辞|LLM 措辞/,
      );
      await page.getByRole("button", { name: "展开调度理由" }).click();
      await expect(page.locator(".agent-reason-full")).toContainText(
        data.hours[14].agent.explanation.split("。")[1],
      );
      await page.keyboard.press("Escape");
      await info.attach("agent-upper-source-labels", {
        body: await page.screenshot({
          path: info.outputPath("agent-upper-source-labels.png"),
        }),
        contentType: "image/png",
      });
    });
  });
  });
