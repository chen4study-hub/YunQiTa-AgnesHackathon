import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { createDataManifest } from "../scripts/dataManifest";
it("hashes exact JSON bytes deterministically, changes only updated files and never writes inputs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "yunqi-manifest-"));
  try {
    await mkdir(path.join(dir, "nested"));
    await writeFile(path.join(dir, "a.json"), '{"value":1}');
    await writeFile(path.join(dir, "nested/b.json"), "[2]\n");
    await writeFile(path.join(dir, "a.json.br"), "ignored");
    const first = await createDataManifest(dir);
    expect(first.files["a.json"]).toEqual({
      sha256: createHash("sha256").update('{"value":1}').digest("hex"),
      bytes: 11,
    });
    expect(Object.keys(first.files)).toEqual(["a.json", "nested/b.json"]);
    expect(await createDataManifest(dir)).toEqual(first);
    await writeFile(path.join(dir, "a.json"), '{"value":2}');
    const next = await createDataManifest(dir);
    expect(next.files["a.json"].sha256).not.toBe(first.files["a.json"].sha256);
    expect(next.files["nested/b.json"]).toEqual(first.files["nested/b.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
