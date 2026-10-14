import { expect, type Page } from "@playwright/test";
import { LLM_LIMIT_NOTICE } from "../src/pages/agent/ChatLlmNotice";
/** Exempt exact model-card field names and the user-authorized LLM banner only. */
export async function forbiddenDisplayText(page: Page) {
  return page.locator("main").evaluate((root, notice) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT),
      bad: string[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const el = node.parentElement,
        text = node.textContent?.trim() ?? "";
      if (
        !el ||
        !text ||
        el.closest("style,script") ||
        !el.checkVisibility({ checkVisibilityCSS: true })
      )
        continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      if (!range.getClientRects().length) continue;
      if (el.matches(".agent-llm-notice") && text === notice) continue;
      if (
        el.closest(".forecast-model th") &&
        ["节假日特征启用", "节假日路由"].includes(text)
      )
        continue;
      if (
        /典型日|情景|代表日|高温日|节假日|回放|模拟|估算|估计|影子模式|演示|推算|沿用|非实测|待人工确认|后日|游标|不是今天的实时测量|原始观测不代表今天的实时测量|BA\/EMS 为调度日志|服务端处理问题；离线模式、未配置或接口异常时使用预置回答|(?<!\d)201[67](?![\d.,])/.test(
          text,
        )
      )
        bad.push(text);
    }
    return bad;
  }, LLM_LIMIT_NOTICE);
}
export async function assertDisplayText(page: Page) {
  expect(await forbiddenDisplayText(page)).toEqual([]);
}
