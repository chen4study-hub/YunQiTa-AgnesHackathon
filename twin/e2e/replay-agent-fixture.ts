import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
/** Mirror the 1.5 split contract without inventing candidates in the main file. */
export function replayWithAgentDetails(scenario: string) {
  const bytes = readFileSync(`public/replay/${scenario}.json`);
  const main = JSON.parse(bytes.toString("utf8"));
  if (main.schema_version !== "1.5") throw new Error("Expected replay 1.5");
  const detail = JSON.parse(
    readFileSync(`public/replay/${main.meta.agent_detail_file}`, "utf8"),
  );
  if (detail.main_sha256 !== createHash("sha256").update(bytes).digest("hex"))
    throw new Error("Detail/main SHA mismatch");
  return {
    ...main,
    hours: main.hours.map((h: any) => {
      const row = detail.hours[String(h.agent.detail_index)];
      if (!row || row.t !== h.t) throw new Error("Detail origin mismatch");
      return { ...h, agent: { ...h.agent, ...row.agent } };
    }),
  };
}
