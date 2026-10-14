import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
const allowed =
  /^(MIT|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|ISC|CC0-1\.0|OFL-1\.1|0BSD|BlueOak-1\.0\.0|\(MIT OR Apache-2\.0\))$/;
const rows = [];
const notices = [];
const installed = new Map();
// The repository-wide notice is maintained separately; this script never writes it.
const emit = process.argv.includes('--emit');
async function scan(base) {
  for (const name of await readdir(base)) {
    if (name.startsWith(".")) continue;
    const dir = path.join(base, name);
    if (name.startsWith("@")) {
      await scan(dir);
      continue;
    }
    try {
      const p = JSON.parse(
        await readFile(path.join(dir, "package.json"), "utf8"),
      );
      if (
        !(p.name === "lightningcss" || p.name.startsWith("lightningcss-")) &&
        !allowed.test(p.license ?? "")
      )
        throw Error(`${p.name}@${p.version}: ${p.license ?? "UNKNOWN"}`);
      installed.set(p.name,p.version);
      rows.push(`${p.name}@${p.version}: ${p.license}`);
      if (emit) {
        const files = await readdir(dir);
        const names = files.filter((name) =>
          /^(licen[cs]e|copying|notice|ofl)([._-]|$)/i.test(name),
        );
        const texts = [];
        const parent = p.name.startsWith("@esbuild/")
          ? "esbuild"
          : p.name.startsWith("@rolldown/binding-")
            ? "rolldown"
            : null;
        if (!names.length && parent) {
          texts.push(
            `License from parent package ${parent}\n${await readFile(path.join("node_modules", parent, "LICENSE"), "utf8")}`,
          );
        }
        if (!names.length && !parent)
          throw Error(`No license text found for ${p.name}`);
        for (const name of names) {
          try {
            texts.push(
              `${name}\n${await readFile(path.join(dir, name), "utf8")}`,
            );
          } catch (error) {
            if (error.code !== "EISDIR") throw error;
          }
        }
        if (!texts.length) throw Error(`No readable license for ${p.name}`);
        notices.push(
          `${p.name}@${p.version} (${p.license})\n${texts.join("\n\n")}`,
        );
      }
      // npm may install a second version beneath a plugin; include its license too.
      await scan(path.join(dir, 'node_modules'));
    } catch (e) {
      if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e;
    }
  }
}
await scan("node_modules");
const manifest = JSON.parse(await readFile('package.json','utf8'));
const locked = JSON.parse(await readFile('package-lock.json','utf8'));
for (const [name,version] of Object.entries({...manifest.dependencies,...manifest.devDependencies})) {
  if (installed.get(name) !== version) throw Error(`Missing or mismatched declared dependency: ${name}@${version}`);
}
for (const [location,pkg] of Object.entries(locked.packages)) {
  if (!location || pkg.optional || pkg.os?.length && !pkg.os.includes(process.platform) || pkg.cpu?.length && !pkg.cpu.includes(process.arch)) continue;
  const actual=JSON.parse(await readFile(path.join(location,'package.json'),'utf8'));
  if (actual.version!==pkg.version) throw Error(`Lockfile version mismatch: ${location}`);
  if (!installed.has(actual.name)) throw Error(`Dependency not included in notices: ${actual.name}`);
}
if (emit) {
  await mkdir("public", { recursive: true });
  const content = 'Frontend third-party license notices\nIncludes installed npm runtime and build dependencies only.\n\n' +
    notices.sort().join('\n\n' + '='.repeat(80) + '\n\n');
  await writeFile('public/THIRD-PARTY-LICENSES.txt',content);
}
console.log(
  `License check: ${rows.length} packages approved\n${rows.sort().join("\n")}`,
);
