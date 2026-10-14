import {
  evaluateOpsSnapshot,
  type OpsDay,
  type OpsElevatorState,
} from "../data/ops";
const ids = ["L1", "L2", "L3", "H1", "H2", "H3"] as const;
/** Missing data is explicitly idle; no locally invented trajectory or elapsed counter. */
export function sceneElevators(
  day: OpsDay | null,
  at_ms: number,
): OpsElevatorState[] {
  const states = day ? evaluateOpsSnapshot(day, at_ms).elevators : [];
  return ids.map(
    (id) =>
      states.find((state) => state.id === id) ?? {
        id,
        floor: 1,
        target: 1,
        status: "idle",
        direction: 0,
        load_pct: 0,
      },
  );
}
export interface SceneOpsFrame {
  at_ms: number;
  day: OpsDay | null;
}
