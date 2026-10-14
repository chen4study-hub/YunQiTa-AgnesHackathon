import { Buffer } from "node:buffer";

/**
 * Windows core.autocrlf checkout can turn LF text artifacts into CRLF.
 * Normalize only CRLF to LF before byte comparisons; preserve every other byte,
 * including isolated CR, BOM, spaces and invalid UTF-8. No decoding or trimming.
 * @param {string | Uint8Array} input
 * @returns {Buffer}
 */
export function normalizeEol(input) {
  const bytes =
    typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  const output = Buffer.allocUnsafe(bytes.length);
  let length = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10) continue;
    output[length++] = bytes[i];
  }
  return output.subarray(0, length);
}
