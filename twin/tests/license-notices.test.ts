import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { normalizeEol } from "./normalize-eol.mjs";
it("public and dist frontend notices match byte-for-byte after EOL normalization and contain declared npm dependencies", async () => {
  // Build first. Only Windows core.autocrlf CRLF/LF differences are normalized.
  const frontend = normalizeEol(
    await readFile("public/THIRD-PARTY-LICENSES.txt"),
  );
  expect(
    normalizeEol(await readFile("dist/THIRD-PARTY-LICENSES.txt")).equals(
      frontend,
    ),
  ).toBe(true);
  const text = frontend.toString("utf8");
  expect(text).toContain("npm runtime and build dependencies only");
  expect(text).not.toContain("Third-party data notices");
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  for (const [name, version] of Object.entries({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  })) {
    const installed = JSON.parse(
      await readFile(path.join("node_modules", name, "package.json"), "utf8"),
    );
    expect(installed.version).toBe(version);
    expect(text).toContain(`${name}@${version} (${installed.license})`);
  }
});
it("root notice includes the complete frontend notice byte-for-byte after EOL normalization", async () => {
  const frontend = normalizeEol(
    await readFile("public/THIRD-PARTY-LICENSES.txt"),
  );
  const root = normalizeEol(await readFile("../THIRD_PARTY_NOTICES"));

  expect(root.includes(frontend)).toBe(true);
});
