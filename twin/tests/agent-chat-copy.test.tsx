import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { chat } from "../src/pages/agent/api";
import { streamChat } from "../src/pages/agent/chat-stream";
import { ChatReply } from "../src/pages/agent/ChatAnswerText";
import { answerCopy, processCopy } from "../src/pages/agent/chat-copy";
import { ChatProcess } from "../src/pages/agent/ChatProcess";

afterEach(() => vi.unstubAllGlobals());
const origin = "2017-01-01T14:00:00Z";
async function both(
  known: boolean,
  needs_human: boolean,
  answer: string,
  reason?: string,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          grounded: true,
          known,
          reason,
          needs_human,
          answer,
          tool_trace: [],
        }),
      ),
    ),
  );
  const json = await chat("问题", "normal", origin);
  const events = [
    { type: "answer_delta", text: answer },
    { type: "done", grounded: true, known, needs_human, reason },
  ];
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
        ),
      ),
  );
  const stream = await streamChat("问题", "normal", origin, () => {});
  return [json, stream];
}
it("known=false and needs_human=false preserves the backend answer, without a handoff claim", async () => {
  for (const r of await both(
    false,
    false,
    "2026 年奖项尚未公布，暂无获奖者名单。",
  )) {
    expect(r?.text).toBe("2026 年奖项尚未公布，暂无获奖者名单。");
    expect(r?.text).not.toContain("已转人工");
  }
});
it("even out_of_scope preserves server text without scope replacement, for JSON and SSE", async () => {
  for (const r of await both(false, false, "不知道", "out_of_scope"))
    expect(r?.text).toBe("不知道");
});
it("no_data and answered preserve backend text, including 不知道 and empty text", async () => {
  for (const reason of ["no_data", "answered"])
    for (const answer of ["不知道", "暂无相关运维记录。", "", "  "])
      for (const r of await both(false, false, answer, reason))
        expect(r?.text).toBe(answer);
});
it("needs_human=true preserves backend answer and the review flag, including known=true", async () => {
  for (const known of [false, true])
    for (const r of await both(known, true, "不知道")) {
      expect(r?.text).toBe("不知道");
      expect(r?.needsHuman).toBe(true);
      expect(r?.text).not.toContain("服务端未提供工具记录");
    }
});
it("transport failures mark request error outside the unchanged answer", async () => {
  for (const response of [
    new Response(JSON.stringify({ error: "backend failed" })),
    new Response("", { status: 503 }),
  ]) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    expect((await chat("问题", "normal", origin))?.text).toBe("");
  }
  for (const response of [
    new Response('data: {"type":"error","message":"failed"}\n\n'),
    new Response("", { status: 503 }),
  ]) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    expect((await streamChat("问题", "normal", origin, () => {}))?.text).toBe(
      "",
    );
  }
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  expect((await chat("问题", "normal", origin))?.text).toBe("");
  expect((await streamChat("问题", "normal", origin, () => {}))?.text).toBe("");
});
it("zero tools has no finished process row, and every tool name is Chinese", () => {
  const message = {
    id: 1,
    role: "assistant" as const,
    source: "backend" as const,
    text: "答复",
    tools: [],
    process: [],
  };
  expect(renderToStaticMarkup(<ChatProcess message={message} />)).toBe("");
  for (const tool of [
    "get_forecast",
    "current_energy",
    "web_search",
    "unknown_backend_tool",
  ]) {
    const html = renderToStaticMarkup(
      <ChatProcess
        message={{
          ...message,
          process: [
            { id: 1, kind: "tool", tool, text: "已完成", state: "done" },
          ],
        }}
      />,
    );
    expect(html.replace(/<[^>]+>/g, "")).not.toContain(tool);
    expect(html).toMatch(/查询/);
    expect(html).toContain("已调用 1 个工具");
  }
});

it("legacy blank/nonanswers remain verbatim without frontend scope gating", async () => {
  for (const answer of [
    "",
    "  ",
    "不知道",
    "不知道。",
    " 不知道！？ ",
    "不清楚。",
    "请联网查询最近的新闻。",
  ])
    for (const r of await both(false, false, answer))
      expect(r?.text).toBe(answer);
});

it("peak answer is byte-for-byte intact for JSON and SSE even when human review is needed", async () => {
  const answer =
    "未来预测最高负荷约 1,265 kW，出现在 12:00，该时段风险偏高，暂不自动执行……";
  for (const r of await both(true, true, answer)) {
    expect(r?.text).toBe(answer);
    expect(r?.needsHuman).toBe(true);
  }
  for (const answer of ["", "  "])
    for (const r of await both(false, true, answer)) {
      expect(r?.text).toBe(answer);
      expect(r?.needsHuman).toBe(true);
    }
});
it("review tag sits below preserved answer, never replaces it, and is absent while pending", () => {
  const answer = "  最高负荷 1,265 kW，出现在 12:00。";
  const html = renderToStaticMarkup(<ChatReply text={answer} needsHuman />);
  // SSR inserts React boundary comments around formatted numeric/unit nodes.
  // Compare rendered text, still exactly, rather than adjacent HTML bytes.
  // 88456e4: accept only ASCII space or NBSP; all other text stays exact.
  expect(html.replace(/<[^>]*>/g, "").split("需值班人员复核")[0].replace(/\u00a0/g, " ")).toBe(answer);
  expect(html.indexOf("agent-answer-review")).toBeGreaterThan(
    html.indexOf("agent-answer-text"),
  );
  expect(html).toContain("需值班人员复核");
  expect(
    renderToStaticMarkup(<ChatReply text={answer} needsHuman pending />),
  ).not.toContain("需值班人员复核");
  expect(renderToStaticMarkup(<ChatReply text={answer} />)).not.toContain(
    "需值班人员复核",
  );
});
it("technical process narration is plain Chinese without changing returned answer copy", () => {
  const text = "已读取指定当地日期范围内、起报后的逐步预测及门控。";
  expect(processCopy(text)).toBe("已读取所选日期后续的负荷预测与风险判断。");
  expect(answerCopy(true, true, text, [])).toBe(text);
});

it("missing or malformed JSON answer produces no answer template", async () => {
  for (const answer of [undefined, null, 23]) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            grounded: true,
            needs_human: true,
            answer,
            tool_trace: [{ tool: "get_forecast" }],
          }),
        ),
      ),
    );
    const result = await chat("峰值？", "normal", origin);
    expect(result?.text).toBe("");
    expect(result?.requestError).toBe(true);
  }
});

it("mode, grounding, known, reason, origin and error flags never replace server text", async () => {
  for (const mode of ["llm", "fallback"])
    for (const answer of [
      "",
      "  ",
      "后端自己选择的 fallback 文案。",
      "该问题因敏感词被拦截。",
    ]) {
      const fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            answer,
            mode,
            grounded: false,
            known: false,
            needs_human: true,
            reason: "no_data",
            error: "flag",
            origin: "other",
          }),
        ),
      );
      vi.stubGlobal("fetch", fetch);
      const json = await chat("问题", "normal", origin);
      expect(json?.text).toBe(answer);
      expect(json?.mode).toBe(mode);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            [
              { type: "answer_delta", text: answer },
              {
                type: "done",
                mode,
                grounded: false,
                known: false,
                needs_human: true,
              },
            ]
              .map((e) => `data: ${JSON.stringify(e)}\n\n`)
              .join("")
              .replaceAll("\\n", "\n"),
          ),
        ),
      );
      const sse = await streamChat("问题", "normal", origin, () => {});
      expect(sse?.text).toBe(answer);
      expect(sse?.mode).toBe(mode);
    }
});

it("termination category labels wrap backend refusal without inventing a classification", () => {
  for (const [category, label] of [
    ["politics", "涉政"],
    ["current_affairs", "时事"],
  ]) {
    const html = renderToStaticMarkup(
      <ChatReply text="后端拒绝原文" terminated category={category} />,
    );
    expect(html).toContain(label);
    expect(html).toContain("后端拒绝原文");
    expect(
      renderToStaticMarkup(<ChatReply text="允许回答" category={category} />),
    ).not.toContain("agent-answer-category");
  }
  expect(
    renderToStaticMarkup(
      <ChatReply text="未知类别原文" terminated category="unknown" />,
    ),
  ).not.toContain("agent-answer-category");
});
