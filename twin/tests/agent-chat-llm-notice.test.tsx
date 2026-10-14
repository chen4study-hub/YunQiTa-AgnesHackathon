import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ChatLlmNotice,
  LLM_LIMIT_NOTICE,
} from "../src/pages/agent/ChatLlmNotice";
import { health } from "../src/pages/agent/api";
const render = (online: boolean | undefined, roles: ("user" | "assistant")[]) =>
  renderToStaticMarkup(
    <ChatLlmNotice
      online={online}
      messages={roles.map((role) => ({ role }))}
    />,
  );
afterEach(() => vi.unstubAllGlobals());
it("no LLM: first user message reveals the exact persistent, non-dismissible banner", () => {
  const html = render(false, ["user"]);
  expect(html).toContain(LLM_LIMIT_NOTICE);
  expect(html).toContain('role="status"');
  expect(html).not.toMatch(/button|关闭/);
  expect(render(false, ["user", "assistant", "user"])).toContain(
    LLM_LIMIT_NOTICE,
  );
});
it("no LLM: before the first user message or after new session reset, no banner", () => {
  expect(render(false, [])).toBe("");
  expect(render(false, ["assistant"])).toBe("");
});
it("real LLM: never show the banner, before or after any user message", () => {
  expect(render(true, [])).toBe("");
  expect(render(true, ["user", "assistant"])).toBe("");
});
it("pending health does not flash a no-LLM claim", () => {
  expect(render(undefined, ["user"])).toBe("");
});
it("health mode real alone suppresses the notice; non-real modes reveal it after sending", async () => {
  for (const mode of ["real", "mock", "off", undefined]) {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ llm: { mode } }))),
    );
    expect(Boolean(render(await health(), ["user"]))).toBe(mode !== "real");
  }
});
