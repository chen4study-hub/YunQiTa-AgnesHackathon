import opsCalendar from "./generated/ops-calendar.js";
import replay12 from "./generated/replay-1.2.js";
import replay13 from "./generated/replay-1.3.js";
import replay14 from "./generated/replay-1.4.js";
import replay15 from "./generated/replay-1.5.js";
import agentDetail from "./generated/agent-detail.js";
import type { SchemaValidator } from "./types";
export { validationErrorsText } from "./types";
export type { SchemaValidator, SchemaError } from "./types";

/** Full ops union: day, calendar and floors-sidecar schema validation. */
export { validateOps } from "./ops";
/** Calendar-only checker, matching Agent record-history's existing schema. */
export const validateOpsCalendar: SchemaValidator = opsCalendar;
/** Schema-only check. Keep SHA/identity/index business checks at the caller. */
export const validateAgentDetail: SchemaValidator = agentDetail;
const replayValidators: Record<string, SchemaValidator> = {
  "1.2": replay12,
  "1.3": replay13,
  "1.4": replay14,
  "1.5": replay15,
};
const unsupported: SchemaValidator = () => {
  unsupported.errors = [
    {
      instancePath: "/schema_version",
      schemaPath: "#/properties/schema_version",
      keyword: "enum",
      params: { allowedValues: Object.keys(replayValidators) },
      message: "must be a supported version (1.2–1.5)",
    },
  ];
  return false;
};
/** Select a precompiled checker. Usage: validateReplay(version)(input). */
export function validateReplay(version: string): SchemaValidator {
  return Object.hasOwn(replayValidators, version)
    ? replayValidators[version]
    : unsupported;
}
