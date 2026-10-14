import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
const root = new URL("../../", import.meta.url);
const target = new URL("../public/replay/", import.meta.url);
const snapshots = new URL("../src/data/contracts/", import.meta.url);
const scenarios = ["normal", "peak", "abstain"];
const ajv = new Ajv({
  allErrors: true,
  strictNumbers: true,
  strictTypes: false,
  multipleOfPrecision: 8,
});
addFormats(ajv);
const committed = process.argv.includes("--committed");
const revision = committed
  ? execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fileURLToPath(root),
      encoding: "utf8",
    }).trim()
  : null;
const read = (path) =>
  committed
    ? Promise.resolve(
        execFileSync("git", ["show", `${revision}:${path}`], {
          cwd: fileURLToPath(root),
          maxBuffer: 64 * 1024 * 1024,
        }),
      )
    : readFile(new URL(path, root));
const schemas = {};
for (const name of ["replay", "replay-1.4", "agent-detail", "ops"]) {
  const bytes = await read(`contracts/${name}.schema.json`);
  schemas[name] = { bytes, validate: ajv.compile(JSON.parse(bytes)) };
}
const files = [
  "index.json",
  "LICENSE",
  ...scenarios.flatMap((sc) => [
    `${sc}.json`,
    `${sc}.agent-detail.json`,
    `${sc}.ops.json`,
  ]),
  "ops-calendar.json",
];
// The ops main declares split floor evidence. Otherwise floors are inline in hours.
for (const sc of scenarios) {
  const ops = JSON.parse(await read(`exports/replay/${sc}.ops.json`));
  const name = ops.meta.floors_file;
  if (name === undefined) continue;
  if (name !== `${sc}.ops-floors.json`)
    throw new Error(`楼层明细路径不匹配: ${sc}`);
  files.push(name);
}
const payloads = new Map();
for (const name of files) {
  const bytes = await read(`exports/replay/${name}`);
  if (name.endsWith(".json") && name !== "index.json") {
    const input = JSON.parse(bytes);
    const schema = name.includes("agent-detail")
      ? "agent-detail"
      : name.includes("ops")
        ? "ops"
        : "replay";
    const v = schemas[schema].validate;
    if (!v(input))
      throw new Error(`${name} schema: ${ajv.errorsText(v.errors)}`);
  }
  payloads.set(name, bytes);
}
for (const sc of scenarios) {
  const main = JSON.parse(payloads.get(`${sc}.json`));
  const detail = JSON.parse(payloads.get(`${sc}.agent-detail.json`));
  const sha = createHash("sha256")
    .update(payloads.get(`${sc}.json`))
    .digest("hex");
  if (
    main.schema_version !== "1.5" ||
    main.meta.agent_detail_file !== `${sc}.agent-detail.json` ||
    detail.main_sha256 !== sha ||
    detail.scenario !== sc ||
    detail.building_id !== main.meta.building_id
  )
    throw new Error(`${sc}: main/detail mismatch`);
  for (const hour of main.hours) {
    const row = detail.hours[String(hour.agent.detail_index)];
    if (
      !row ||
      row.t !== hour.t ||
      row.agent.selected !== hour.agent.selected ||
      row.agent.explanation !== hour.agent.explanation
    )
      throw new Error(`${sc}: detail_index mismatch`);
  }
}
payloads.set("model_card.json", await read("exports/model_card.json"));
const check = process.argv.includes("--check");
if (revision) console.log(`Reading committed exports at ${revision}`);
if (!check) {
  await mkdir(target, { recursive: true });
  await mkdir(snapshots, { recursive: true });
}
for (const [name, bytes] of payloads) {
  const dest = new URL(name, target);
  if (!check) await writeFile(dest, bytes);
  if (!bytes.equals(await readFile(dest)))
    throw new Error(`逐字节不一致: ${name}`);
  // Detect concurrent model export rewrites, rather than committing mixed evidence.
  if (
    name !== "model_card.json" &&
    !bytes.equals(await read(`exports/replay/${name}`))
  )
    throw new Error(`同步期间源文件改变: ${name}`);
}
for (const [name, { bytes }] of Object.entries(schemas)) {
  const dest = new URL(`${name}.schema.json`, snapshots);
  if (!check) await writeFile(dest, bytes);
  if (
    !bytes.equals(await readFile(dest)) ||
    !bytes.equals(await read(`contracts/${name}.schema.json`))
  )
    throw new Error(`契约快照不一致: ${name}`);
}
console.log(
  `${check ? "Verified" : "Synced and verified"} ${payloads.size} exports + ${Object.keys(schemas).length} schemas: byte-exact, schema-valid, main_sha256/index matched.`,
);
