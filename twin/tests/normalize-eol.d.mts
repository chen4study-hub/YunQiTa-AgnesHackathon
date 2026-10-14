import type { Buffer } from "node:buffer";

/** Normalize CRLF only, preserving all other bytes without decoding or trimming. */
export function normalizeEol(input: string | Uint8Array): Buffer;
