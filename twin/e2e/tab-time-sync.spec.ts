import { expect, test, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
const measurements: Record<string, number[]> = {};
test.beforeEach(() => {
  for (const key of Object.keys(measurements)) delete measurements[key];
});
test.afterEach(async ({ context }, testInfo) => {
  writeFileSync(
    testInfo.outputPath("measurements.json"),
    JSON.stringify(measurements),
  );
  await context.close();
});
const url = "/?source=mock&scenario=normal&at=2026-10-12T14:23:05";
const ready = async (page: Page) => {
  await expect(page.locator(".timeline")).toBeVisible({ timeout: 60000 });
  await expect(page.locator(".bottombar button").first()).toBeVisible({
    timeout: 60000,
  });
};
const control = async (
  actor: Page,
  peer: Page,
  kind: "play" | "pause" | "select" | "current" | "reset",
) => {
  // Observe in the receiving tab, so 200ms includes channel delivery and UI paint,
  // not Playwright's cross-process locator polling or click auto-waits.
  await peer.evaluate((kind) => {
    const w = window as any;
    w.syncProbe = new Promise<number>((resolve) => {
      const observer = new MutationObserver(() => {
        const playing = document
          .querySelector(".timeline")
          ?.getAttribute("data-playing");
        const time = document.querySelector(".clock")?.textContent ?? "";
        const returnButton = Array.from(
          document.querySelectorAll(".bottombar button"),
        ).some((b) => b.textContent?.includes("回到当前"));
        const matched =
          kind === "play"
            ? playing === "true"
            : kind === "select"
              ? time.endsWith("00:00:00")
              : kind === "current" || kind === "reset"
                ? playing === "false" &&
                  !returnButton &&
                  time.endsWith("14:23:05")
                : playing === "false";
        if (matched) {
          observer.disconnect();
          resolve(Date.now());
        }
      });
      observer.observe(document.querySelector(".bottombar")!, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    });
  }, kind);
  const started = await actor.evaluate((kind) => {
    const started = Date.now();
    if (kind === "select") {
      document
        .querySelector<HTMLElement>(".timeline")!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
        );
    } else {
      const buttons = Array.from(
        document.querySelectorAll<HTMLButtonElement>(".bottombar button"),
      );
      (kind === "current"
        ? buttons.find((b) => b.textContent?.includes("回到当前"))!
        : buttons[0]
      ).click();
    }
    return started;
  }, kind);
  const arrived = await peer.evaluate(
    () => (window as any).syncProbe as Promise<number>,
  );
  console.log(kind, "sync latency ms", arrived - started);
  (measurements[kind] ??= []).push(arrived - started);
  // Busy-machine acceptance uses the median of three independent spec runs.
  expect.soft(arrived - started).toBeLessThanOrEqual(200);
};
const clock = async (page: Page) => page.locator(".clock").textContent();
test("two tabs share time controls, late join, background catch-up and reset only", async ({
  context,
}) => {
  test.setTimeout(180000);
  const a = await context.newPage();
  await a.goto(url);
  const popup = a.waitForEvent("popup");
  await a.evaluate((url) => {
    (window as any).peerWindow = window.open(url);
  }, url);
  const b = await popup;
  for (const page of [a, b])
    page.on("pageerror", (error) => console.log("pageerror", error.message));
  for (const page of [a, b]) {
    // Both pages are already navigated; keep the opener's peer Window reference.
    await ready(page);
    await page.getByRole("button", { name: "关于", exact: false }).click();
    await expect(
      page.getByRole("button", { name: "关于", exact: false }),
    ).toHaveAttribute("aria-pressed", "true", { timeout: 60000 });
  }
  await control(a, b, "play");
  await a.waitForTimeout(150);
  // Pause samples the shared wall clock, including time since the last rendered frame.
  await control(b, a, "pause");
  expect(await clock(a)).toBe(await clock(b));
  await control(a, b, "select");
  expect(await clock(a)).toBe(await clock(b));
  await control(b, a, "current");
  expect(await clock(a)).toBe(await clock(b));
  await a.getByRole("button", { name: "关于", exact: false }).click();
  await control(a, b, "play");
  const c = await context.newPage();
  await c.goto(url);
  await expect(c.locator(".timeline")).toHaveAttribute("data-playing", "true");
  await expect(
    a.getByRole("button", { name: "关于", exact: false }),
  ).toHaveAttribute("aria-pressed", "true", { timeout: 60000 });
  await expect(
    c.getByRole("button", { name: "总览", exact: false }),
  ).toHaveAttribute("aria-pressed", "true");
  await c.getByRole("button", { name: "关于", exact: false }).click();
  await expect(
    c.getByRole("button", { name: "关于", exact: false }),
  ).toHaveAttribute("aria-pressed", "true");
  const session = await context.newCDPSession(b);
  await a.bringToFront();
  await session.send("Page.setWebLifecycleState", { state: "frozen" });
  await a.waitForTimeout(800);
  const restoredAt = await a.evaluate(() => Date.now());
  await session.send("Page.setWebLifecycleState", { state: "active" });
  await b.bringToFront();
  const catchupMs = await a.evaluate(async (restoredAt) => {
    const peer = (window as any).peerWindow as Window;
    const value = (doc: Document) => {
      const text = doc.querySelector(".clock")!.textContent!;
      const match = text.match(/(\d{2}):(\d{2}):(\d{2})$/)!;
      return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    };
    while (Date.now() - restoredAt < 1500) {
      const delta = Math.abs(value(document) - value(peer.document));
      if (Math.min(delta, 86400 - delta) <= 60) return Date.now() - restoredAt;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return Date.now() - restoredAt;
  }, restoredAt);
  console.log("background catch-up ms", catchupMs);
  measurements.backgroundCatchupMs = [catchupMs];
  expect.soft(catchupMs).toBeLessThanOrEqual(1000);
  await control(b, a, "pause");
  expect(await clock(a)).toBe(await clock(b));
  await expect(c.locator(".timeline")).toHaveAttribute("data-playing", "false");
  expect(await clock(c)).toBe(await clock(a));
  await control(a, b, "play");
  await expect(a.locator(".bottombar button").first()).toContainText("重置", {
    timeout: 26000,
  });
  await expect(b.locator(".bottombar button").first()).toContainText("重置");
  await control(b, a, "reset");
  await expect(c.locator(".clock")).toHaveText((await clock(a))!);
  await session.detach();
  await a.close();
  await b.close();
  await c.close();
});
// At 3600x playback, 360 displayed seconds are 0.1 seconds of real time.
test("playing clock boxes differ by at most 360 displayed seconds", async ({
  context,
}) => {
  test.setTimeout(90000);
  const a = await context.newPage();
  await a.goto(url);
  await ready(a);
  await a.getByRole("button", { name: "关于", exact: false }).click();
  const popup = a.waitForEvent("popup");
  await a.evaluate((url) => {
    (window as any).peerWindow = window.open(url);
  }, url);
  const b = await popup;
  await ready(b);
  await b.getByRole("button", { name: "关于", exact: false }).click();
  await a.locator(".bottombar button").first().click();
  await expect(b.locator(".timeline")).toHaveAttribute("data-playing", "true");
  const differences = await a.evaluate(async () => {
    const peer = (window as any).peerWindow as Window;
    const seconds = (text: string) => {
      const match = text.match(/(\d{2}):(\d{2}):(\d{2})$/)!;
      return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    };
    const result: number[] = [];
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const left = seconds(document.querySelector(".clock")!.textContent!);
      const right = seconds(
        peer.document.querySelector(".clock")!.textContent!,
      );
      const delta = Math.abs(left - right);
      result.push(Math.min(delta, 86400 - delta));
    }
    return result;
  });
  console.log("displayed clock differences seconds", differences);
  measurements.clockDifferenceSeconds = [Math.max(...differences)];
  expect.soft(Math.max(...differences)).toBeLessThanOrEqual(360);
  await a.close();
  await b.close();
});
