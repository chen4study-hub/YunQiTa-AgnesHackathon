import { useEffect, useState } from "react";
import type { Takeover } from "../pages/agent/takeover-api";
import { pollActiveTakeover } from "./activeTakeover";

export function useActiveTakeover(date: string, hour: number): Takeover | null {
  const scope = `${date}|${hour}`;
  const [state, setState] = useState<{
    scope: string;
    record: Takeover | null;
  }>({ scope, record: null });
  useEffect(
    () =>
      pollActiveTakeover(date, hour, (record) => setState({ scope, record })),
    [date, hour, scope],
  );
  return state.scope === scope ? state.record : null;
}
