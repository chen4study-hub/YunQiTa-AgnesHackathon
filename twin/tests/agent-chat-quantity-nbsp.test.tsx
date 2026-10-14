import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "@playwright/test";
import { expect, it } from "vitest";
import { quantityText } from "../src/pages/agent/ChatQuantity";
import { ChatReply } from "../src/pages/agent/ChatAnswerText";

it.each([
  ["1.20 元/kWh", "1.20\u00a0元/kWh"],
  ["2.0  kW", "2.0\u00a0kW"],
  ["12.0\tkWh", "12.0\u00a0kWh"],
  ["-2.5\u202f°C", "-2.5\u00a0°C"],
  ["95.0 %", "95.0\u00a0%"],
  ["1,200.0 m³/h", "1,200.0\u00a0m³/h"],
  ["35.6\u00a0ms", "35.6\u00a0ms"],
])("keeps precision and emits a textual NBSP for %s", (input, expected) => {
  const html = renderToStaticMarkup(<>{quantityText(`前文 ${input} 后文`)}</>);
  expect(html).toBe(
    `前文 <span class="agent-answer-quantity">${expected}</span> 后文`,
  );
});

it("preserves unrelated text and URLs", () => {
  const html = renderToStaticMarkup(
    <ChatReply text="**1.20 元/kWh**；3 seasons；[来源](https://example.com/1.20)" />,
  );
  expect(html).toContain(
    '<strong><span class="agent-answer-quantity">1.20\u00a0元/kWh</span></strong>',
  );
  expect(html).toContain("；3 seasons；");
  expect(html).toContain('href="https://example.com/1.20"');
});

it("textContent includes NBSP and quantities do not split under narrow wrapping", async () => {
  const browser = await chromium.launch({
    channel: "msedge",
    args: [
      "--disable-frame-rate-limit",
      "--disable-gpu-vsync",
      "--renderer-process-limit=1",
    ],
  });
  try {
    const page = await browser.newPage();
    const html = renderToStaticMarkup(
      <div className="agent-root">
        <ChatReply text="电价 **1.20 元/kWh**，负荷 `2.0 kW`。" />
      </div>,
    );
    const css = readFileSync("src/pages/agent/chat-steps.css", "utf8");
    await page.setContent(`<style>${css}
      .agent-answer-text { width: 1px; font: 16px sans-serif; overflow-wrap: anywhere; word-break: break-all; }
    </style>${html}`);
    expect(await page.locator(".agent-answer-text").textContent()).toBe(
      "电价 1.20\u00a0元/kWh，负荷 2.0\u00a0kW。",
    );
    const quantities = await page
      .locator(".agent-answer-quantity")
      .evaluateAll((elements) =>
        elements.map((element) => {
          const text = element.firstChild as Text;
          const range = document.createRange();
          const style = getComputedStyle(element);
          const rects = Array.from({ length: text.length }, (_, index) => {
            range.setStart(text, index);
            range.setEnd(text, index + 1);
            const rect = range.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom };
          });
          return {
            text: element.textContent,
            rects,
            display: style.display,
            whiteSpace: style.whiteSpace,
            overflowWrap: style.overflowWrap,
            wordBreak: style.wordBreak,
            gap: style.columnGap,
            unitChildren: element.childElementCount,
          };
        }),
      );
    expect(quantities.map((quantity) => quantity.text)).toEqual([
      "1.20\u00a0元/kWh",
      "2.0\u00a0kW",
    ]);
    for (const quantity of quantities) {
      expect(quantity).toMatchObject({
        display: "inline-block",
        whiteSpace: "nowrap",
        overflowWrap: "normal",
        wordBreak: "normal",
        gap: "normal",
        unitChildren: 0,
      });
      expect(new Set(quantity.rects.map((rect) => rect.top)).size).toBe(1);
      expect(new Set(quantity.rects.map((rect) => rect.bottom)).size).toBe(1);
    }
  } finally {
    await browser.close();
  }
}, 60_000);
