import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";

it("the browser ops loader production bundle has no Ajv constructor/compiler or unused validators", async () => {
  const result = await build({
    entryPoints: ["src/data/ops/loader.ts"],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    minify: true,
    metafile: true,
    write: false,
  });
  const sources = Object.values(result.metafile!.outputs).flatMap((output) =>
    Object.entries(output.inputs)
      .filter(([, value]) => value.bytesInOutput > 0)
      .map(([file]) => file),
  );
  expect(sources).toContain("src/data/validators/generated/ops.js");
  expect(
    sources.some((file) => /node_modules\/(ajv|ajv-formats)\//.test(file)),
  ).toBe(false);
  expect(
    sources.some((file) =>
      /\.schema\.json$|generated\/(replay|agent-detail|ops-calendar)/.test(
        file,
      ),
    ),
  ).toBe(false);
  expect(result.outputFiles[0].text).not.toMatch(
    /new Ajv|\.compile\(|new Function/,
  );
  expect(
    Object.values(result.metafile!.outputs).every(
      (output) => output.imports.length === 0,
    ),
  ).toBe(true);
});
it("every generated module is self-contained browser ESM without runtime compilation", async () => {
  const directory = "src/data/validators/generated";
  const files = (await readdir(directory)).filter((name) =>
    name.endsWith(".js"),
  );
  expect(files).toHaveLength(7);
  for (const file of files) {
    const source = await readFile(path.join(directory, file), "utf8");
    // Ajv runtime helpers retain inert .code metadata strings containing
    // require(...). They are not calls; verify no external imports via bundling.
    expect(source, file).not.toMatch(/new Ajv|\.compile\(|new Function/);
    const bundled = await build({
      entryPoints: [path.join(directory, file)],
      bundle: true,
      platform: "browser",
      format: "esm",
      metafile: true,
      write: false,
    });
    expect(
      Object.values(bundled.metafile!.outputs).every(
        (output) => output.imports.length === 0,
      ),
    ).toBe(true);
    expect(source, file).toContain("export{");
  }
});
