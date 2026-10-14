import ops from "./generated/ops.js";
import type { SchemaValidator } from "./types";
/** Full ops union. Separate entry keeps unused replay validators off this chain. */
export const validateOps: SchemaValidator = ops;
