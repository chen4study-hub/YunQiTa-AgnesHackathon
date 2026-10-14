#!/usr/bin/env node
/** Standalone Windows PowerShell runner (also works in an extracted git archive).
 * Prerequisites: Node 22.12+ (tested: 24.21), npm ci in twin, installed Microsoft
 * Edge (Playwright channel msedge), powershell.exe on PATH, and permission to
 * query Win32_Process / stop this runner's own residual child processes.
 * Node 20.19+ is also supported by Vite; prefer maintained Node 22/24 LTS.
 * No .git, Git executable, Agnes tools, global Playwright, or fixed Node path
 * is needed. All paths resolve from this script; children use process.execPath.
 * From twin in an ordinary PowerShell:
 *   npm ci
 *   node e2e/run-groups.mjs --list
 *   node e2e/run-groups.mjs shell-time
 *   node e2e/run-groups.mjs forecast-agent
 *   node e2e/run-groups.mjs all
 * --list uses Node built-ins only: no dependencies, browsers, servers or Git.
 * New spec names must match exactly one rule; unassigned/duplicate names fail.
 *
 * Runner environment variables (unset defaults shown):
 * - PLAYWRIGHT_PORT=5191: integer 1024..65535, bound at 127.0.0.1. Occupied ports
 *   fail; existing servers are NEVER reused/stopped. Every run uses workers=1.
 * - E2E_GROUP_SHARD=unset: optional i/N. Explicit PARTIAL run, per-test sharding
 *   via --fully-parallel but still ONE worker. Run all N shards for full coverage.
 * - E2E_GROUP_OUTPUT_ROOT=<twin>/test-results: report/artifact parent directory;
 *   set an absolute path (e.g. Join-Path $env:TEMP 'twin-e2e') for archive/CI runs.
 * - E2E_GROUP_SPEC_FILTER=unset: comma-separated exact spec basenames for targeted
 *   regression only; no skips inserted. The runner verifies own Edge peak <=8.
 * - E2E_GROUP_TEST_LIST_INVERT=unset: optional absolute Playwright test-list file
 *   of previously executed tests to exclude. Explicit PARTIAL scope; combine
 *   reports to prove coverage. Lines: spec path relative to e2e > suite > title.
 * - E2E_GROUP_GLOBAL_TIMEOUT_MS=unset: optional positive integer suite budget
 *   in milliseconds. Expiry exits nonzero and reports unfinished tests separately.
 * Outputs: <parent>/groups-<UTC>/<group>/report.json and artifacts/. Console logs
 * go to stdout/stderr; redirect them externally to $env:TEMP if desired.
 * PATH is inherited with the current Node directory prepended for Vite's node.
 * PLAYWRIGHT_JSON_OUTPUT_NAME is overridden per group (caller value ignored).
 * Other environment variables are inherited unchanged for individual specs;
 * they are not runner options. Live API specs may require an existing backend
 * at 127.0.0.1:8000; runner never starts/restarts it. --list checks no prerequisites.
 *
 * Exit 0: requested scope completed with no failed tests/report/cleanup errors
 * (skips are counted, not treated as failures; a shard is never a full-group pass).
 * Exit 1: invalid args/grouping/env, missing prerequisites, occupied port,
 * test failure, missing/empty/error report, interruption or unverified cleanup.
 * all continues after test failures, but stops on unsafe cleanup/interruption.
 * Process cleanup uses recorded PID + creation time; unrelated sessions untouched.
 * The runner never builds twin/dist or changes product/spec files. Individual
 * specs define their own fixtures/prerequisites; this is not a frozen-source run.
 */
import { readdir, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, delimiter, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const e2e = join(root, "e2e");
const exec = promisify(execFile);
const rules = [
  {
    name: "shell-time",
    label: "壳层和时间轴",
    pattern:
      /^(?:timeline-.+|current-.+|viewed-time-consistency|mobile-(?:shell|footer-inset|timeline-.+)|tab-time-.+|playback-hour-.+|rolling-playback|replay(?:-.+)?|frame|footer-frame-boundary|shell|favicon|logo|build-revision|precompressed-preview|presentation-metadata|page-error-boundary|lazy-page-loading|data-contract\d+)$/,
  },
  {
    name: "overview-3d",
    label: "总览和 3D",
    pattern:
      /^(?:about(?:-.+)?|overview(?:-.+)?|scene-(?!paused$|draw-calls$|smoothness$|lifecycle-performance$).+|scene|tower-.+|mobile-(?:scene-.+|canvas-.+)|decision-source-label|showcase)$/,
  },
  {
    name: "forecast-agent",
    label: "预测与 Agent",
    pattern: /^(?:agent(?:-.+)?|forecast(?:-.+)?|shared-live-schedule)$/,
  },
  {
    name: "floors-energy",
    label: "楼层与能源",
    pattern:
      /^(?:floor(?:s|-.+)?|ops-floor-.+|energy(?:-.+)?|ems-.+|lift-.+|elevator-.+|compact-pages|mobile-pages)$/,
  },
  {
    name: "cross-page",
    label: "跨页回归：浮窗、禁词、滚动、字号",
    pattern:
      /^(?:cross-page-.+|page-(?:chart-.+|grid|live-.+|metric-.+|readable-.+|table-.+|transitions|visual-.+)|pages|public-readable-.+|site-.+|scroll-policy|shell-scroll-policy|number-precision|chart-tooltip-.+|compact-content|intrinsic-layout|responsive)$/,
  },
  {
    name: "performance",
    label: "性能动画",
    pattern:
      /^(?:chart-resume-performance|playback-performance|prediction-animation|raf-baseline|scene-(?:draw-calls|paused|smoothness|lifecycle-performance))$/,
  },
];

async function discover(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await discover(path)));
    else if (entry.isFile() && /\.spec\./.test(entry.name)) files.push(path);
  }
  return files.sort();
}

async function classify() {
  const groups = new Map(rules.map((rule) => [rule.name, []]));
  const errors = [];
  for (const file of await discover(e2e)) {
    const name = basename(file).replace(/\.spec\..*$/, "");
    const matches = rules.filter((rule) => rule.pattern.test(name));
    const path = relative(root, file).replaceAll("\\", "/");
    if (matches.length !== 1)
      errors.push(
        `${path}: ${matches.length ? "duplicate: " + matches.map((r) => r.name).join(", ") : "unassigned"}`,
      );
    else groups.get(matches[0].name).push(path);
  }
  if (errors.length)
    throw new Error(
      "Spec grouping failed (update filename rules before running):\n" +
        errors.join("\n"),
    );
  return groups;
}

// Windows process identities include creation time to guard against recycled PIDs.
async function processSnapshot() {
  if (process.platform !== "win32")
    throw new Error(
      "Cleanup verification currently requires Windows; refusing an unverified run.",
    );
  const script =
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n="Created";e={$_.CreationDate.ToUniversalTime().ToString("o")}} | ConvertTo-Json -Compress';
  const { stdout } = await exec(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { maxBuffer: 8 * 1024 * 1024, timeout: 15000 },
  );
  const value = JSON.parse(stdout.replace(/^\uFEFF/, ""));
  return Array.isArray(value) ? value : [value];
}

async function monitorTree(pid) {
  const started = Date.now();
  const known = new Map();
  let failure;
  let stopped = false;
  let pending = Promise.resolve();
  let peakEdge = 0;
  async function sample() {
    const rows = await processSnapshot();
    // Seed with only this runner's direct Playwright child, not other sessions.
    const rootRow = rows.find((row) => row.ProcessId === pid);
    if (
      rootRow &&
      !known.has(pid) &&
      rootRow.ParentProcessId === process.pid &&
      Date.parse(rootRow.Created) >= started - 1000
    )
      known.set(pid, rootRow);
    let changed;
    do {
      changed = false;
      for (const row of rows) {
        const parent = known.get(row.ParentProcessId);
        const liveParent = rows.find(
          (p) => p.ProcessId === row.ParentProcessId,
        );
        if (
          !known.has(row.ProcessId) &&
          parent &&
          liveParent?.Created === parent.Created &&
          Date.parse(row.Created) >= Date.parse(parent.Created) &&
          Date.parse(row.Created) >= started - 1000
        ) {
          known.set(row.ProcessId, row);
          changed = true;
        }
      }
    } while (changed);
    const ownEdge = rows.filter((row) =>
      row.Name.toLowerCase() === "msedge.exe" &&
      known.get(row.ProcessId)?.Created === row.Created
    );
    peakEdge = Math.max(peakEdge, ownEdge.length);
    if (ownEdge.length > 8) {
      // Do not kill any untracked browser. Stop this run's exact Edge identities.
      const ids = Buffer.from(JSON.stringify(ownEdge.map(row => ({ pid: row.ProcessId, created: row.Created }))), "utf8").toString("base64");
      await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `$ids=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${ids}'))); foreach($i in $ids){$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$i.pid); if($p -and $p.CreationDate.ToUniversalTime().ToString('o') -eq $i.created){Stop-Process -Id $i.pid -Force}}`
      ], { timeout: 15000 });
    }
  }
  function tick() {
    pending = sample()
      .catch((error) => {
        failure = error;
      })
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, 1500);
      });
  }
  let timer;
  tick();
  return async function finish() {
    stopped = true;
    clearTimeout(timer);
    await pending;
    if (failure)
      throw new Error("Process monitoring failed: " + failure.message);
    // Playwright normally disposes these. Clean up only recorded, still-identical descendants.
    let rows = await processSnapshot();
    const survivors = () =>
      rows.filter((row) => known.get(row.ProcessId)?.Created === row.Created);
    const remaining = survivors();
    const foreign = remaining.filter(
      (p) => !/^(node|cmd|msedge)\.exe$/i.test(p.Name),
    );
    if (foreign.length)
      throw new Error(
        "Unexpected process in tracked tree; refusing to stop it: " +
          foreign.map((p) => `${p.Name}:${p.ProcessId}`).join(", "),
      );
    if (remaining.length) {
      console.log(
        "Closing own residual processes: " +
          remaining.map((p) => `${p.Name}:${p.ProcessId}`).join(", "),
      );
      const identities = JSON.stringify(
        remaining.map((p) => ({ pid: p.ProcessId, created: p.Created })),
      );
      const encoded = Buffer.from(identities, "utf8").toString("base64");
      const script = `$ids=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))); foreach($i in $ids){$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$i.pid); if($p -and $p.CreationDate.ToUniversalTime().ToString('o') -eq $i.created){Stop-Process -Id $i.pid -Force -ErrorAction Stop}}`;
      await exec(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        { timeout: 15000 },
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      rows = await processSnapshot();
    }
    if (survivors().length)
      throw new Error(
        "Own Vite/Edge/process tree did not close: " +
          survivors()
            .map((p) => p.ProcessId)
            .join(", "),
      );
    if (!known.size)
      throw new Error(
        "Could not observe the Playwright process tree; cleanup unverified.",
      );
    console.log(
      `Cleanup verified: ${known.size} observed own processes exited (Vite/Edge included); other sessions untouched. Peak own Edge processes: ${peakEdge}/8.`,
    );
    if (peakEdge > 8) throw new Error(`Own Edge process cap exceeded: ${peakEdge}/8; own browser terminated, no foreign processes touched.`);
  };
}

async function assertPortFree(port) {
  const { createServer } = await import("node:net");
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error) =>
      reject(
        new Error(
          `Port ${port} is not free; no existing server will be stopped: ${error.message}`,
        ),
      ),
    );
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
}

function reportCounts(report) {
  const counts = {
    passed: 0,
    failed: 0,
    skipped: 0,
    notRun: 0,
    interrupted: 0,
    flaky: 0,
  };
  function visit(suite) {
    for (const spec of suite.specs ?? [])
      for (const test of spec.tests ?? []) {
        const last = test.results?.at(-1);
        if (last?.status === "interrupted") counts.interrupted++;
        else if (test.status === "skipped" && test.expectedStatus !== "skipped")
          counts.notRun++;
        else if (test.status === "expected") counts.passed++;
        else if (test.status === "flaky") {
          counts.passed++;
          counts.flaky++;
        } else if (test.status === "skipped") counts.skipped++;
        else counts.failed++;
      }
    for (const child of suite.suites ?? []) visit(child);
  }
  for (const suite of report.suites ?? []) visit(suite);
  return counts;
}

async function runGroup(name, files, port, runDir) {
  if (!files.length)
    throw new Error(`Group ${name} has no specs; refusing an empty pass.`);
  await assertPortFree(port);
  const output = join(runDir, name);
  await mkdir(output, { recursive: true });
  const reportPath = join(output, "report.json");
  // Explicit per-test shards support hosts without persistent background processes.
  const shard = process.env.E2E_GROUP_SHARD;
  if (shard) {
    const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(shard);
    if (!match || +match[1] > +match[2])
      throw new Error("E2E_GROUP_SHARD must be i/N, 1 <= i <= N.");
    console.log(
      `EXPLICIT PARTIAL GROUP: shard ${shard}; run every shard for full coverage.`,
    );
  }
  const excluded = process.env.E2E_GROUP_TEST_LIST_INVERT;
  const budget = process.env.E2E_GROUP_GLOBAL_TIMEOUT_MS;
  if (
    budget &&
    (!/^[1-9]\d*$/.test(budget) || !Number.isSafeInteger(Number(budget)))
  )
    throw new Error("E2E_GROUP_GLOBAL_TIMEOUT_MS must be a positive integer.");
  if (excluded)
    console.log(`EXPLICIT PARTIAL GROUP: excluding tests from ${excluded}`);
  // Escape filename regex metacharacters and anchor the end so Playwright never picks another spec.
  const selected = files.map(
    (file) => file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$",
  );
  console.log(
    `\n=== ${name}: ${files.length} files, port=${port}, workers=1 ===`,
  );
  const start = performance.now();
  const child = spawn(
    process.execPath,
    [
      join(root, "node_modules/@playwright/test/cli.js"),
      "test",
      ...(process.env.E2E_GROUP_CONFIG ? ["--config", process.env.E2E_GROUP_CONFIG] : []),
      ...selected,
      "--workers=1",
      ...(shard ? ["--fully-parallel", `--shard=${shard}`] : []),
      ...(excluded ? ["--test-list-invert", excluded] : []),
      ...(budget ? [`--global-timeout=${budget}`] : []),
      "--reporter=line,json",
      `--output=${join(output, "artifacts")}`,
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        PATH: dirname(process.execPath) + delimiter + (process.env.PATH ?? ""),
        PLAYWRIGHT_PORT: String(port),
        PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath,
      },
    },
  );
  const finish = await monitorTree(child.pid);
  let interrupted = false;
  const stop = () => {
    interrupted = true;
    child.kill();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let code, cleanupError;
  try {
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    try {
      await finish();
      await assertPortFree(port);
    } catch (error) {
      cleanupError = error.message;
    }
  }
  const seconds = ((performance.now() - start) / 1000).toFixed(1);
  let counts, reportError;
  try {
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    counts = reportCounts(report);
    if (report.errors?.length)
      reportError = report.errors
        .map((e) => e.message ?? JSON.stringify(e))
        .join("; ");
    if (counts.passed + counts.failed + counts.skipped === 0)
      reportError = "No tests reported";
  } catch (error) {
    reportError = "Cannot read Playwright JSON report: " + error.message;
  }
  return {
    group: name,
    ...(shard || excluded ? { shard, excluded, partial: true } : {}),
    seconds,
    ...(counts ?? { passed: "?", failed: "?", skipped: "?", flaky: "?" }),
    exit: code ?? "signal",
    error: [reportError, cleanupError, interrupted ? "Interrupted" : null]
      .filter(Boolean)
      .join("; "),
    unsafe: !!cleanupError || interrupted,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (
    args.length !== 1 ||
    !["--list", "all", ...rules.map((r) => r.name)].includes(args[0])
  ) {
    throw new Error(
      "Usage: node e2e/run-groups.mjs <--list|all|" +
        rules.map((r) => r.name).join("|") +
        ">",
    );
  }
  const groups = await classify(); // Validate every spec even when only one group is requested.
  const only = process.env.E2E_GROUP_SPEC_FILTER;
  if (only) {
    const names = only.split(",");
    const all = [...groups.values()].flat();
    for (const name of names) {
      if (!all.some(file => basename(file) === name)) throw new Error(`Unknown exact spec filter: ${name}`);
    }
    for (const [group, files] of groups) groups.set(group, files.filter(file => names.includes(basename(file))));
    console.log(`EXPLICIT TARGETED SPECS: ${names.join(", ")}`);
  }
  if (args[0] === "--list") {
    for (const rule of rules) {
      const files = groups.get(rule.name);
      console.log(`\n${rule.name} — ${rule.label} (${files.length} files)`);
      for (const file of files) console.log("  " + file);
    }
    console.log(
      `\nValidated: ${[...groups.values()].flat().length} specs, exactly one group each.`,
    );
    return;
  }
  const rawPort = process.env.PLAYWRIGHT_PORT ?? "5191";
  if (
    !/^\d+$/.test(rawPort) ||
    Number(rawPort) < 1024 ||
    Number(rawPort) > 65535
  )
    throw new Error("PLAYWRIGHT_PORT must be an integer from 1024 to 65535.");
  const port = Number(rawPort);
  await processSnapshot(); // Fail before starting browsers if cleanup cannot be verified.
  const runDir = join(
    process.env.E2E_GROUP_OUTPUT_ROOT ?? join(root, "test-results"),
    "groups-" + new Date().toISOString().replace(/[:.]/g, "-"),
  );
  const requested = args[0] === "all" ? rules.map((r) => r.name) : args;
  const results = [];
  for (const name of requested) {
    const result = await runGroup(name, groups.get(name), port, runDir);
    results.push(result);
    if (result.error) console.error(`${name}: ${result.error}`);
    // Test failures do not hide later groups. Unsafe cleanup/interruption stops immediately.
    if (result.unsafe) break;
  }
  console.log("\nGroup summary (seconds include process cleanup):");
  console.table(results);
  console.log("Reports/artifacts: " + relative(root, runDir));
  if (results.some((r) => r.exit !== 0 || r.error || r.failed !== 0))
    process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
