/**
 * Bounded live smoke test of the Blaxel adapter (SANDBOX lane B5). Dev only.
 *
 *   SANDBOX_SMOKE_CONFIRM=1 infisical run --env dev -- npm run smoke:blaxel
 *
 * It goes through the seam (`createBlaxelProvider`, called directly until #911 registers it);
 * the raw SDK only reads what the seam hides (status, standby state, events, the raw list) and
 * sweeps. Guards are the harness's (3 sandboxes, one at a time, $1 per log file); each sandbox's
 * lifetime is the adapter's date policy, at most 15 minutes from creation, so Blaxel deletes it
 * even if this script dies. The SDK reads ./.env and ./blaxel.toml from the cwd first, so run it
 * from a checkout without either.
 *
 * Sandboxes: "a" (the seam, the files, the Vite preview, the #911 gate, standby, teardown),
 * "c" (the Next starter: disk, memory, check-build's copy and build against their deadlines)
 * and "d" (a 2-minute date policy deletes it on time).
 */
import { SandboxInstance, getBlaxelErrorStatus } from "@blaxel/core";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { NEXT_APP_STARTER } from "../../src/features/conversations/inngest/next-starter";
import { VITE_REACT_STARTER } from "../../src/features/conversations/inngest/vite-starter";
import { STREAM_REDACTION_PLACEHOLDER, createStreamRedactor } from "../../src/features/integrations/server/env/stream-redactor";
import {
  DEV_COMMAND_ENV, DEV_SERVER_ENVS, PREVIEW_PROXY_PORT, PROXY_SCRIPT_PATH, PROXY_TARGET_ENV, isPortOpen, runDevServer,
} from "../../src/features/sandbox-preview/server/dev-server";
import { DEFAULT_INSTALL_COMMAND, WORK_DIR, offlineFirstInstall } from "../../src/features/sandbox-preview/server/project-sandbox";
import { assertExactExecStream, createBlaxelProvider } from "../../src/features/sandbox-preview/server/provider/blaxel";
import { killTree, listCommands, listProcesses } from "../../src/features/sandbox-preview/server/provider/helpers";
import {
  type RunOptions, type Sandbox, SandboxConfigError, SandboxNotFoundError, SandboxTimeoutError,
} from "../../src/features/sandbox-preview/server/provider/types";
import { appendHostFlag, detectFrameworkFromFiles } from "../../src/features/sandbox-preview/utils/dev-command";
import {
  BROWSER, alphanumeric, createSmoke, describe, errorName, expect, get, openHmr, proxySource, refuse, requireDevConfirmation, sleep, until,
} from "./harness";

const env = process.env;
requireDevConfirmation("creates live Blaxel sandboxes, about $0.10");
if (!env.BL_API_KEY?.trim() || !env.BL_WORKSPACE?.trim()) refuse("BL_API_KEY and BL_WORKSPACE must be set");

const provider = createBlaxelProvider();
/** Blaxel's errors can be raw bodies: their name and HTTP status by the SDK's own reader. */
const blStatus = (error: unknown) => `${errorName(error)} ${getBlaxelErrorStatus(error) ?? "-"}`;

// A child with a bad key: the SDK reads its credentials once per process.
if (process.argv[2] === "--bad-key-probe") {
  const error = await provider.list({ metadata: { purpose: "smoke" }, limit: 1 }).then(() => undefined, (caught: unknown) => caught);
  console.log(JSON.stringify({ name: error ? errorName(error) : "no error", cause: error ? blStatus((error as Error).cause) : "-" }));
  process.exit(0);
}

const SLOT_MS = 12 * 60_000;
const GATE_PORT = 4101;
const BLAXEL = /blaxel/i;

// The real deadlines the streamed output must meet. check-build.ts keeps its own private, so they are mirrored here.
/** api/sandbox/route.ts INSTALL_TIMEOUT_MS, and the terminal's reinstall ([sandboxId]/route.ts). */
const BOOT_INSTALL_MS = 5 * 60_000;
/** route.ts waitForPublicUrl's default since #930. */
const PUBLIC_URL_WAIT_MS = 10_000;
/** check-build.ts: CHECK_TIMEOUT_MS (install + build together), COPY_TIMEOUT_MS, STEP_BUDGET_MS. */
const CHECK_TIMEOUT_MS = 180_000;
const COPY_TIMEOUT_MS = 30_000;
const STEP_BUDGET_MS = 240_000;
/** blaxel.ts DEFAULT_RUN_TIMEOUT_MS: a `run` without its own limit, as the agent's shell tools make. */
const DEFAULT_RUN_MS = 60_000;

const { runId, meta, log, LIFETIME_MS, record, withSandbox, finish, check, measure } = createSmoke({
  vendor: "blaxel", provider,
  // The adapter's 4 GB at the active price; standby is cheaper, so this overestimates.
  usdPerHour: 4 * 0.0000115 * 3600, rateNote: "4 GB x active s x $0.0000115/GB-s",
  /** Every sandbox labelled with the run (raw list, any status) and every id it created, read back one by one. */
  async sweep(runId, everCreated, log) {
    try {
      const ids = new Set(everCreated);
      let page = await SandboxInstance.list({ q: runId, limit: 100 });
      for (;;) {
        for (const listed of page.data) if (listed.metadata.labels?.runId === runId) ids.add(listed.metadata.name);
        const next = page.hasMore ? await page.nextPage() : undefined;
        if (!next) break;
        page = next;
      }
      let leftovers = 0;
      for (const id of ids) {
        const status = await SandboxInstance.get(id).then((got) => got.status ?? "unknown", (error) => blStatus(error));
        if (status.endsWith(" 404") || status === "DELETING" || status === "TERMINATED") continue;
        leftovers++;
        const deleted = await SandboxInstance.delete(id).then(() => true, (error) => blStatus(error));
        log({ event: "sweep-kill", id, status, deleted });
      }
      return leftovers;
    } catch (error) {
      log({ event: "sweep-failed", error: blStatus(error) });
      return null;
    }
  },
});

/** The control plane's view: status, standby state, events and lifecycle (a read; it does not resume). */
async function rawView(id: string) {
  const sandbox = await SandboxInstance.get(id);
  const { state } = (sandbox as unknown as { sandbox: { state?: string } }).sandbox;
  const events = sandbox.events ?? [];
  return {
    status: sandbox.status, state, createdAt: sandbox.metadata.createdAt, updatedAt: sandbox.metadata.updatedAt,
    events: events.length, lastEvent: events.at(-1)?.status, policy: sandbox.spec.lifecycle?.expirationPolicies?.map(({ value }) => value).join(","),
  };
}
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const elapsed = (from: number) => seconds(Date.now() - from);
const createdAtOf = async (id: string) => Date.parse((await SandboxInstance.get(id)).metadata.createdAt ?? "");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** What updateLifecycle must not lose: the process, its port, a file and the VM's boot. */
async function fingerprint(sandbox: Sandbox, pid: number, port: number) {
  const { stdout } = await sandbox.run(
    `test -d /proc/${pid} && echo alive; curl -s -m 5 localhost:${port}; echo; cat /home/user/gate/keep.txt; echo; ` +
    "cat /proc/sys/kernel/random/boot_id; cut -d' ' -f1 /proc/uptime",
  );
  const [alive, served, file, boot, uptime] = stdout.split("\n");
  return { alive: alive === "alive", served, file, boot, uptime: Number(uptime) };
}

/**
 * connect({ timeoutMs }) never shortens, then extends endAt toward `untilMs` after the
 * server's createdAt (within the 15-minute backstop); the endAt before and after.
 */
async function extend(sandbox: Sandbox, untilMs: number) {
  const before = (await sandbox.info()).endAt.getTime();
  await provider.connect(sandbox.id, { timeoutMs: 60_000 });
  const unchanged = (await sandbox.info()).endAt.getTime();
  expect(unchanged === before, `a 1-minute connect moved endAt by ${unchanged - before} ms`);
  const target = await createdAtOf(sandbox.id) + Math.min(untilMs, LIFETIME_MS);
  // Whole minutes, rounded down, so the new endAt stays at or before the target.
  const minutes = Math.floor((target - Date.now()) / 60_000);
  expect(Date.now() + minutes * 60_000 > before, "no room to extend within the backstop");
  const startedAt = Date.now();
  await provider.connect(sandbox.id, { timeoutMs: minutes * 60_000 });
  const connectMs = Date.now() - startedAt;
  const after = (await sandbox.info()).endAt.getTime();
  expect(after > before && after <= target + 5_000, `endAt moved ${after - before} ms; ${after - target} ms past the target`);
  return { before, after, connectMs };
}

const blocker = (name: string, detail: string) => {
  log({ event: "blocker", name, detail });
  console.error(`\n*** BLOCKER (#911 gate): ${name}: ${detail}\n`);
};

/**
 * `run`, timed from outside (wall) and inside the sandbox (the command alone), with the
 * chunks the caller's callback got; the difference is what streaming adds.
 */
async function timed(sandbox: Sandbox, command: string, opts: Omit<RunOptions, "onStdout" | "onStderr">, callback = true) {
  let chunks = 0;
  let bytes = 0;
  const onData = (data: string) => { chunks++; bytes += Buffer.byteLength(data); };
  const wrapped = `s=$(date +%s%3N); ( ${command} ); rc=$?; echo $(( $(date +%s%3N) - s )) > /tmp/smoke-duration; exit $rc`;
  const started = Date.now();
  const result = await sandbox.run(wrapped, { ...opts, ...(callback ? { onStdout: onData, onStderr: onData } : {}) });
  const wallMs = Date.now() - started;
  const innerMs = Number((await sandbox.readFile("/tmp/smoke-duration", "text")).trim());
  return { result, wallMs, innerMs, chunks, bytes };
}
const describeTimed = ({ result, wallMs, innerMs, chunks, bytes }: Awaited<ReturnType<typeof timed>>, deadlineMs: number) =>
  `exit ${result.exitCode}; wall ${seconds(wallMs)} (in-sandbox ${seconds(innerMs)}, streaming +${wallMs - innerMs} ms); ` +
  `${chunks} chunks, ${bytes} B to the callback; deadline ${seconds(deadlineMs)}`;
/** A deadline row: it fails when the command fails or breaks the deadline, even with the output right. */
const deadlineRow = (name: string, deadlineMs: number, run: () => Promise<Awaited<ReturnType<typeof timed>>>) =>
  check(`a ${name} within ${seconds(deadlineMs)}`, async () => {
    const timing = await run();
    const detail = describeTimed(timing, deadlineMs);
    expect(timing.result.exitCode === 0, `${detail}: ${timing.result.stderr.slice(-200)}`);
    expect(timing.wallMs <= deadlineMs, `past the deadline: ${detail}`);
    return detail;
  });

/** Polls `url` every 250 ms, as waitForPublicUrl does: when it first answered (non-5xx, non-404) and when it first gave 200. */
async function firstAnswer(url: string, maxMs: number) {
  const started = Date.now();
  let answered: number | undefined;
  let ok: number | undefined;
  while (Date.now() - started < maxMs && ok === undefined) {
    const response = await get(url).catch(() => undefined);
    await response?.body?.cancel();
    if (response && response.status < 500 && response.status !== 404) answered ??= Date.now() - started;
    if (response?.status === 200) ok = Date.now() - started;
    if (ok === undefined) await sleep(250);
  }
  return { answered, ok };
}

const df = async (sandbox: Sandbox, path = "/home/user") =>
  (await sandbox.run(`df -h ${path} | tail -1; free -m | sed -n 2p`)).stdout.trim().replace(/\s+/g, " ");

log({ event: "start", workspace: "BL_WORKSPACE set", region: env.BL_REGION?.trim() || "us-was-1 (default)" });
try {
  await check("8d a bad BL_API_KEY raises SandboxConfigError", async () => {
    const args = [...process.execArgv, fileURLToPath(import.meta.url), "--bad-key-probe"];
    const { stdout } = await promisify(execFile)(process.execPath, args, {
      env: { ...env, BL_API_KEY: "bl_smoke_invalid_key" }, encoding: "utf8", timeout: 60_000,
    });
    const probe = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
    expect(probe.name === SandboxConfigError.name, `got ${JSON.stringify(probe)}`);
    return `cause ${probe.cause}`;
  });

  await withSandbox("a", SLOT_MS, async (sandbox) => {
    const createdAt = Date.now();
    await check("1 labels round-trip through info and list; listed endAt; another user (case, prefix) lists none", async () => {
      const info = await sandbox.info();
      for (const [key, value] of Object.entries(meta)) expect(info.metadata[key] === value, `info lost ${key}`);
      const listed = await until(async () => {
        const found = await provider.list({ metadata: { userId: meta.userId, runId } });
        return found.length ? found : undefined;
      }, 30_000, 250) ?? [];
      const listLag = elapsed(createdAt);
      expect(listed.length === 1 && listed[0].id === sandbox.id, `list returned ${listed.length}`);
      for (const [key, value] of Object.entries(meta)) expect(listed[0].metadata[key] === value, `list lost ${key}`);
      expect(listed[0].endAt.getTime() > Date.now(), "listed endAt is not in the future");
      const drift = Math.abs(listed[0].endAt.getTime() - info.endAt.getTime());
      expect(drift < 5_000, `listed endAt is ${drift} ms off info's`);
      const lower = await provider.list({ metadata: { userId: meta.userId.toLowerCase(), runId } });
      const prefix = await provider.list({ metadata: { userId: meta.userId.slice(0, -1), runId } });
      expect(lower.length === 0 && prefix.length === 0, `another user listed ${lower.length} (lowercase), ${prefix.length} (prefix)`);
      return `id ${sandbox.id}; listed ${listLag} after create returned; endAt in ${Math.round((info.endAt.getTime() - Date.now()) / 1000)} s`;
    });

    // The #911 gate, first, so a redeploy shows before anything else depends on the sandbox. It extends
    // to 13 minutes from creation, leaving 6b room to extend again on the live preview.
    let gatePid = 0;
    let gateBoot = "";
    await check("6a GATE connect -> updateLifecycle keeps the running server, its pid and files; extends only, within the backstop", async () => {
      await sandbox.writeFiles([{ path: "/home/user/gate/keep.txt", data: "kept" }]);
      ({ pid: gatePid } = await sandbox.start(
        `node -e "require('http').createServer((q, s) => s.end('gate-ok')).listen(${GATE_PORT})"`,
        { envs: { [DEV_COMMAND_ENV]: "smoke-gate" } },
      ));
      expect(await until(() => isPortOpen(sandbox, GATE_PORT), 15_000), `:${GATE_PORT} did not open`);
      const before = await fingerprint(sandbox, gatePid, GATE_PORT);
      expect(before.alive && before.served === "gate-ok" && before.file === "kept", `not ready: ${JSON.stringify(before)}`);
      gateBoot = before.boot;
      const viewBefore = await rawView(sandbox.id);
      const { before: endBefore, after: endAfter, connectMs } = await extend(sandbox, 13 * 60_000);
      const now = await fingerprint(sandbox, gatePid, GATE_PORT);
      // A redeploy could land a little later: look again after 20 s.
      await sleep(20_000);
      const later = await fingerprint(sandbox, gatePid, GATE_PORT);
      const viewLater = await rawView(sandbox.id);
      const kept = [now, later].every((print) =>
        print.alive && print.served === "gate-ok" && print.file === "kept" && print.boot === before.boot && print.uptime > before.uptime);
      const detail = `before ${JSON.stringify(before)} ${JSON.stringify(viewBefore)} | after ${JSON.stringify(now)} | ` +
        `+20 s ${JSON.stringify(later)} ${JSON.stringify(viewLater)}`;
      if (!kept) blocker("updateLifecycle lost the sandbox's state", detail);
      expect(kept, detail);
      return `pid ${gatePid} kept, same boot, uptime ${before.uptime} -> ${later.uptime} s; endAt +${Math.round((endAfter - endBefore) / 1000)} s ` +
        `(connect ${connectMs} ms); ${viewBefore.status}/${viewBefore.state} -> ${viewLater.status}/${viewLater.state}; events ${viewBefore.events} -> ${viewLater.events}`;
    });

    await check("2a exit 3 is a result; stdout/stderr separate, sync and streamed", async () => {
      const sync = await sandbox.run("echo out; echo err >&2; exit 3");
      expect(sync.exitCode === 3 && sync.stdout === "out\n" && sync.stderr === "err\n", `sync ${JSON.stringify(sync)}`);
      const streamed = await sandbox.run("echo out; echo err >&2; exit 3", { onStdout: () => {} });
      expect(streamed.exitCode === 3 && streamed.stdout === "out\n" && streamed.stderr === "err\n", `streamed ${JSON.stringify(streamed)}`);
    });
    await check("2b timeoutMs 2000 on sleep 5 throws SandboxTimeoutError and the process is gone", async () => {
      const started = Date.now();
      const error = await sandbox.run("sleep 5", { timeoutMs: 2000 }).then(() => undefined, (caught: unknown) => caught);
      expect(error instanceof SandboxTimeoutError, `got ${error ? blStatus(error) : "no error"}`);
      const after = Date.now() - started;
      const left = (await listProcesses(sandbox)).filter((process) => /sleep$/.test(process.cmd) && process.args[0] === "5");
      expect(!left.length, `sleep 5 still running: ${left.map((process) => process.pid)}`);
      return `after ${after} ms`;
    });
    await check("2c 150 s commands, streamed and without caller callbacks, at once: both complete with no 504", async () => {
      let ticks = 0;
      const started = Date.now();
      const [silent, streamed] = await Promise.all([
        sandbox.run("sleep 150; echo done", { timeoutMs: 200_000 }),
        sandbox.run("for i in $(seq 1 15); do echo tick; sleep 10; done", {
          timeoutMs: 200_000, onStdout: (data) => { ticks += data.split("tick").length - 1; },
        }),
      ]);
      expect(silent.exitCode === 0 && silent.stdout === "done\n", `silent ${JSON.stringify(silent)}`);
      expect(streamed.exitCode === 0 && ticks === 15, `streamed exit ${streamed.exitCode}, ${ticks} ticks`);
      return elapsed(started);
    });
    await check("2d cwd and env are applied, values with ' and $", async () => {
      const value = "a b'c $HOME $(id) \"q\"";
      const result = await sandbox.run(`pwd; printf '%s' "$SMOKE_VAR"`, { cwd: "/tmp", envs: { SMOKE_VAR: value } });
      expect(result.stdout === `/tmp\n${value}`, JSON.stringify(result.stdout));
    });
    await check("2g stdout comes back byte-exact, sync and streamed; the image passes assertExactExecStream", async () => {
      await assertExactExecStream(await SandboxInstance.get(sandbox.id));
      const got: string[] = [];
      for (const expected of ["x", "x\n", "a\n\nb\n", "\n\n", "no newline at end"]) {
        const command = `printf '${expected.replaceAll("\n", "\\n")}'`;
        for (const opts of [{}, { onStdout: () => {} }]) {
          const { stdout } = await sandbox.run(command, opts);
          if (stdout !== expected) got.push(`${command} -> ${JSON.stringify(stdout)}`);
        }
      }
      expect(!got.length, got.join("; "));
    });
    await check("2h output over 64 KB comes back whole, many lines and one long line", async () => {
      const lines = `${Array.from({ length: 30_000 }, (_, index) => index + 1).join("\n")}\n`;
      const many = (await sandbox.run("seq 1 30000")).stdout;
      const long = (await sandbox.run("head -c 100000 /dev/zero | tr '\\0' a", { onStdout: () => {} })).stdout;
      expect(many === lines, `seq: ${many.length} of ${lines.length} chars`);
      expect(long === "a".repeat(100_000), `one line: ${long.length} of 100000 chars`);
      return `${many.length} + ${long.length} chars`;
    });
    await check("2f the image: shell, user, home, node 22, g++, warm ~/.npm, tools, npm registry", async () => {
      const { stdout } = await sandbox.run(
        'echo "$0 $(whoami) $HOME $(node -v)"; for t in bash timeout sha256sum base64 curl g++ make python3; do command -v $t >/dev/null || echo "missing $t"; done; ' +
        'echo "npm-cache $(du -sh ~/.npm 2>/dev/null | cut -f1)"; ' +
        'for u in https://registry.npmjs.org/ https://example.com/; do echo "$u $(curl -s -o /dev/null -m 10 -w %{http_code} $u)"; done',
        { timeoutMs: 60_000 },
      );
      expect(/ user \/home\/user v22\./.test(stdout) && !stdout.includes("missing"), stdout);
      expect(/registry\.npmjs\.org\/ 200/.test(stdout), `npm not reachable: ${stdout}`);
      return stdout.trim().replaceAll("\n", "; ");
    });
    await check("f the shell tools our commands assume: find -printf, setsid --wait, timeout, base64 -w0, stat -c", async () => {
      // The shapes check-build, sandbox-repair, dev-server and helpers.ts use.
      const probes = {
        "find -printf": "mkdir -p /tmp/f/d && touch /tmp/f/d/x && cd /tmp/f && find . \\( -type f -o -type l \\) -printf '%P\\n'",
        "setsid --wait": "setsid --wait sh -c 'echo ok'",
        timeout: "timeout -k 1 2s sh -c 'echo ok'",
        "base64 -w0": "printf ok | base64 -w0 | base64 -d",
        "stat -c": "stat -c '%n' /tmp/f/d/x",
      };
      const expected: Record<string, string> = { "find -printf": "d/x", "stat -c": "/tmp/f/d/x" };
      const failed: string[] = [];
      for (const [name, command] of Object.entries(probes)) {
        const result = await sandbox.run(command);
        if (result.exitCode !== 0 || result.stdout.trim() !== (expected[name] ?? "ok")) failed.push(`${name}: exit ${result.exitCode} ${JSON.stringify(result.stdout + result.stderr)}`);
      }
      expect(!failed.length, failed.join("; "));
    });

    await check("3 start: log streams with newlines intact; the pid is in /proc and is the marked root; killTree", async () => {
      let output = "";
      const { pid } = await sandbox.start(
        `node -e "require('http').createServer((q, s) => { console.log('hit'); s.end('ok'); }).listen(4100, () => console.log('smoke-listening\\nsecond-line'))"`,
        { envs: { [DEV_COMMAND_ENV]: "smoke-server" }, onStdout: (data) => { output += data; } },
      );
      expect(Number.isInteger(pid) && pid > 0, `pid ${pid}`);
      expect(await until(() => output.includes("second-line"), 15_000), `no streamed log: ${JSON.stringify(output)}`);
      expect(output.includes("smoke-listening\nsecond-line\n"), `newlines lost: ${JSON.stringify(output)}`);
      await sandbox.run("curl -s localhost:4100");
      expect(await until(() => output.includes("hit\n"), 10_000), "no log after start returned");
      expect((await sandbox.run(`test -d /proc/${pid}`)).exitCode === 0, `no /proc/${pid}`);
      const root = (await listCommands(sandbox)).find((command) => command.envs[DEV_COMMAND_ENV] === "smoke-server");
      expect(root?.pid === pid, `root pid ${root?.pid} != start pid ${pid}`);
      expect((await killTree(sandbox, pid)).exitCode === 0, "killTree failed");
      expect(await until(async () => (await sandbox.run(`test -d /proc/${pid}`)).exitCode !== 0, 10_000), "alive after killTree");
      return `pid ${pid} (${root.cmd} ${root.args.slice(0, 1).join(" ")}); streamed ${JSON.stringify(output)}`;
    });

    await check("4a writeFiles text, binary, nested and odd names; readFile both formats", async () => {
      const text = "héllo ✓\n";
      const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
      const odd = "/home/user/smoke/dir with space/ünï#?.txt";
      await sandbox.writeFiles([
        { path: "/home/user/smoke/a.txt", data: text },
        { path: odd, data: "odd" },
        { path: "/home/user/smoke/deep/er/b.bin", data: bytes.buffer },
      ]);
      expect(await sandbox.readFile("/home/user/smoke/a.txt", "text") === text, "text differs");
      expect(await sandbox.readFile(odd, "text") === "odd", "odd path differs");
      const back = await sandbox.readFile("/home/user/smoke/deep/er/b.bin", "bytes");
      expect(back.length === 256 && back.every((byte, index) => byte === index), "bytes differ");
    });
    await check("4c readFile of a missing file is not SandboxNotFoundError", async () => {
      const error = await sandbox.readFile("/home/user/nope.txt", "text").then(() => undefined, (caught: unknown) => caught);
      expect(error && !(error instanceof SandboxNotFoundError), `got ${error ? blStatus(error) : "no error"}`);
      return blStatus(error);
    });
    await check("d big writes: 5000 small files in one writeFiles; 200 binary files of 50 KB", async () => {
      let started = Date.now();
      await sandbox.writeFiles(Array.from({ length: 5000 }, (_, index) => ({ path: `/home/user/many/d${index % 50}/f${index}.txt`, data: `${index}\n` })));
      const small = Date.now() - started;
      const blob = (index: number) => Uint8Array.from({ length: 50 * 1024 }, (_, at) => (at * 31 + index) & 255);
      started = Date.now();
      await sandbox.writeFiles(Array.from({ length: 200 }, (_, index) => ({ path: `/home/user/bins/b${index}.bin`, data: blob(index).buffer })));
      const binary = Date.now() - started;
      const { stdout } = await sandbox.run("find /home/user/many -type f | wc -l; find /home/user/bins -type f -size 51200c | wc -l; sha256sum /home/user/bins/b137.bin | cut -d' ' -f1");
      const [files, bins, digest] = stdout.trim().split("\n");
      expect(files === "5000" && bins === "200", `${files} small files, ${bins} binaries of 50 KB`);
      expect(digest === createHash("sha256").update(blob(137)).digest("hex"), "b137.bin differs");
      return `5000 files in ${seconds(small)}; 200 x 50 KB in ${seconds(binary)}`;
    });
    await check("c a secret printed across a chunk boundary is still redacted by the stream redactor", async () => {
      const secret = `sk_smoke_${alphanumeric(24)}`;
      const cut = 13;
      const chunks: string[] = [];
      // The pause makes sandbox-api flush the first half on its own.
      await sandbox.run(`printf 'before ${secret.slice(0, cut)}'; sleep 1; printf '${secret.slice(cut)} after\\n'`, { onStdout: (data) => { chunks.push(data); } });
      expect(chunks.some((chunk) => chunk.includes(secret.slice(0, cut)) && !chunk.includes(secret)), `the secret was not split: ${chunks.length} chunk(s)`);
      // As route.ts sends each chunk through its stream's redactor.
      const redactor = createStreamRedactor([secret]);
      const sent = chunks.map((chunk) => redactor.push(chunk)).join("") + redactor.flush();
      expect(!sent.includes(secret) && sent === `before ${STREAM_REDACTION_PLACEHOLDER} after\n`, `sent ${JSON.stringify(sent.replace(secret, "<SECRET>"))}`);
      return `${chunks.length} chunks, split inside the secret; sent ${JSON.stringify(sent)}`;
    });
    await deadlineRow("1 MB cat, streamed and byte-exact, run's default limit", DEFAULT_RUN_MS, async () => {
      await sandbox.run("head -c 786432 /dev/urandom | base64 > /tmp/mb.txt");
      const expected = (await sandbox.run("sha256sum < /tmp/mb.txt | cut -d' ' -f1")).stdout.trim();
      const timing = await timed(sandbox, "cat /tmp/mb.txt", { timeoutMs: DEFAULT_RUN_MS });
      expect(sha256(timing.result.stdout) === expected, `${timing.result.stdout.length} chars, not the file`);
      return timing;
    });

    // The Vite preview, as route.ts boots it.
    let previewUrl = "";
    let hmrUrl: URL | undefined;
    let firstOk: { created: number; answered?: number; ok?: number } | undefined;
    const proxyRoot = async () => (await listCommands(sandbox)).find((command) => command.envs[PROXY_TARGET_ENV]);
    const devRoot = async () => (await listCommands(sandbox)).find((command) => command.envs[DEV_COMMAND_ENV]?.includes("npm run dev"));
    const startProxy = async () => {
      await sandbox.writeFiles([{ path: PROXY_SCRIPT_PATH, data: proxySource(5173) }]);
      await sandbox.start(`node ${PROXY_SCRIPT_PATH}`, { envs: { [PROXY_TARGET_ENV]: "5173" } });
      expect(await until(() => isPortOpen(sandbox, PREVIEW_PROXY_PORT), 10_000), "the proxy did not open :4000");
    };
    const connected = async () => {
      expect(hmrUrl, "no HMR url (5c failed)");
      const hmr = openHmr(hmrUrl);
      try { await hmr.next("connected", 15_000); } finally { hmr.close(); }
    };

    await deadlineRow("Vite starter npm install (boot route, streamed)", BOOT_INSTALL_MS, async () => {
      await sandbox.writeFiles(VITE_REACT_STARTER.map((file) => ({ path: `${WORK_DIR}/${file.path}`, data: file.content })));
      return timed(sandbox, DEFAULT_INSTALL_COMMAND, { cwd: WORK_DIR, timeoutMs: BOOT_INSTALL_MS });
    });
    await check("5a the Vite starter boots behind the :4000 proxy; previewUrl answers a server-side fetch", async () => {
      const command = appendHostFlag("npm run dev", detectFrameworkFromFiles([...VITE_REACT_STARTER]));
      await runDevServer(sandbox, { command, cwd: WORK_DIR, envs: { ...DEV_SERVER_ENVS } });
      expect(await until(() => isPortOpen(sandbox, 5173), 60_000, 1500), "Vite did not open :5173");
      await startProxy();
      // Timed as route.ts waits: right after the proxy opens, from previewUrl() to the first answer and the first 200.
      const started = Date.now();
      previewUrl = await sandbox.previewUrl(PREVIEW_PROXY_PORT);
      firstOk = { created: Date.now() - started, ...await firstAnswer(previewUrl, 30_000) };
      const page = await until(async () => {
        const described = await describe(previewUrl, {}, BLAXEL).catch(() => undefined);
        return described?.status === 200 ? described : undefined;
      }, 30_000, 1000);
      expect(page?.vite, `not the Vite page: ${JSON.stringify(page)}`);
      return `host shape ${new URL(previewUrl).hostname.replace(/^[^.]+/, "<hash>")}; same URL again: ${await sandbox.previewUrl(PREVIEW_PROXY_PORT) === previewUrl}`;
    });
    await check("b time to the first 200 of the boot's preview URL, against waitForPublicUrl's 10 s", async () => {
      expect(firstOk, "no preview (5a failed)");
      const { created, answered, ok } = firstOk;
      const detail = `previewUrl() ${created} ms; then first answer ${answered ?? "-"} ms, first 200 ${ok ?? "-"} ms (polled every 250 ms)`;
      expect(ok !== undefined && ok <= PUBLIC_URL_WAIT_MS, `${detail}; wait ${PUBLIC_URL_WAIT_MS} ms`);
      return detail;
    });
    await check("5b a browser-shaped request reaches Vite too; interstitial, X-Frame-Options, CSP and cookies", async () => {
      expect(previewUrl, "no preview (5a failed)");
      const browser = await describe(previewUrl, { ...BROWSER, "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate", "sec-fetch-site": "cross-site" }, BLAXEL);
      const plain = await describe(previewUrl, {}, BLAXEL);
      expect(browser.vite && plain.vite, `a request did not reach Vite: browser ${JSON.stringify(browser)}, plain ${JSON.stringify(plain)}`);
      const framing = [browser, plain].find((page) => page.xfo || /frame-ancestors/i.test(page.csp ?? ""));
      expect(!framing, `framing is restricted: ${JSON.stringify(framing)}`);
      return `browser ${JSON.stringify(browser)} | plain ${JSON.stringify(plain)}`;
    });
    await check("5c HMR WebSocket through the preview: connects and pushes an update", async () => {
      expect(previewUrl, "no preview (5a failed)");
      const client = await (await get(new URL("/@vite/client", previewUrl))).text();
      const token = /wsToken\s*=\s*"([^"]*)"/.exec(client)?.[1] ?? "";
      hmrUrl = new URL(`/?token=${encodeURIComponent(token)}`, previewUrl.replace(/^http/, "ws"));
      // Put App.tsx in Vite's module graph, as the page's first load would.
      for (const path of ["/src/main.tsx", "/src/App.tsx"]) await (await get(new URL(path, previewUrl))).body?.cancel();
      const hmr = openHmr(hmrUrl);
      try {
        await hmr.next("connected", 15_000);
        const app = VITE_REACT_STARTER.find((file) => file.path === "src/App.tsx");
        expect(app, "the starter has no src/App.tsx");
        const from = hmr.mark();
        await sandbox.writeFiles([{ path: `${WORK_DIR}/src/App.tsx`, data: `${app.content}\n// smoke edit\n` }]);
        await hmr.next("update", 20_000, from).catch(() => hmr.next("full-reload", 1, from));
      } finally {
        hmr.close();
      }
    });
    await check("5d listCommands finds the dev server and proxy; HMR reconnects after a client close and after the proxy is killed", async () => {
      const [dev, proxy] = [await devRoot(), await proxyRoot()];
      expect(dev && proxy, `listCommands found dev ${dev?.pid ?? "none"}, proxy ${proxy?.pid ?? "none"}`);
      await connected();
      const hmr = openHmr(hmrUrl!);
      try {
        await hmr.next("connected", 15_000);
        await killTree(sandbox, proxy.pid);
        expect(await until(() => hmr.isClosed(), 15_000), "the socket stayed open after the proxy died");
      } finally {
        hmr.close();
      }
      await startProxy();
      await connected();
      return `dev ${dev.pid} (${dev.cmd}), proxy ${proxy.pid} (${proxy.cmd})`;
    });
    await measure("5e a preview of a port not declared at create (:5173 directly)", async () => {
      const url = await sandbox.previewUrl(5173);
      const { answered, ok } = await firstAnswer(url, 15_000);
      const response = await get(url);
      await response.body?.cancel();
      return `status ${response.status} (first answer ${answered ?? "-"} ms, first 200 ${ok ?? "-"} ms)`;
    });
    await check("6b GATE on a live preview: connect extends and the dev server, proxy, preview and HMR survive", async () => {
      expect(previewUrl, "no preview (5a failed)");
      const [dev, proxy] = [await devRoot(), await proxyRoot()];
      expect(dev && proxy, `listCommands found dev ${dev?.pid ?? "none"}, proxy ${proxy?.pid ?? "none"}`);
      const { before, after } = await extend(sandbox, LIFETIME_MS);
      await sleep(10_000);
      const [devAfter, proxyAfter] = [await devRoot(), await proxyRoot()];
      const kept = devAfter?.pid === dev.pid && proxyAfter?.pid === proxy.pid;
      const response = await get(previewUrl);
      await response.body?.cancel();
      const detail = `dev ${dev.pid} -> ${devAfter?.pid}, proxy ${proxy.pid} -> ${proxyAfter?.pid}, preview ${response.status}`;
      if (!kept || response.status !== 200) blocker("updateLifecycle lost the live preview", detail);
      expect(kept && response.status === 200, detail);
      await connected();
      return `${detail}; endAt +${Math.round((after - before) / 1000)} s`;
    });
    await check("7 standby: after 60 s with no traffic, the preview and a run still answer and the processes are kept", async () => {
      expect(previewUrl, "no preview (5a failed)");
      const dev = await devRoot();
      expect(dev, "no dev server root");
      // get() is a control-plane read: if the state reaches STANDBY while it polls, get() does not resume.
      const started = Date.now();
      const states: string[] = [];
      while (Date.now() - started < 60_000) {
        const { status, state } = await rawView(sandbox.id);
        const now = `${status}/${state ?? "-"}`;
        if (!states.at(-1)?.startsWith(now)) states.push(`${now}@${Math.round((Date.now() - started) / 1000)}s`);
        await sleep(10_000);
      }
      const resumed = Date.now();
      const response = await get(previewUrl);
      await response.body?.cancel();
      const previewMs = Date.now() - resumed;
      expect(response.status === 200, `status ${response.status}`);
      const runStarted = Date.now();
      expect((await sandbox.run("true")).exitCode === 0, "run failed");
      const runMs = Date.now() - runStarted;
      expect((await devRoot())?.pid === dev.pid, "the dev server's pid changed");
      return `states while idle: ${states.join(" > ")}; then preview ${previewMs} ms, run ${runMs} ms`;
    });
    await check("6a' the gate server, its file and the boot are unchanged at the end of the slot", async () => {
      expect(gatePid, "no gate server (6a failed)");
      const print = await fingerprint(sandbox, gatePid, GATE_PORT);
      expect(print.alive && print.served === "gate-ok" && print.file === "kept" && print.boot === gateBoot, JSON.stringify(print));
      return `${elapsed(createdAt)} after create`;
    });

    await check("8a kill; connect throws NotFound; list empties (polled every 250 ms); a kill once gone is false", async () => {
      expect(await provider.kill(sandbox.id) === true, "kill did not report true");
      const killedAt = Date.now();
      const connect = await provider.connect(sandbox.id).then(() => "connected", (error: unknown) => error);
      expect(connect instanceof SandboxNotFoundError, `connect after kill: ${connect instanceof Error ? blStatus(connect) : connect}`);
      // While it is still DELETING another delete succeeds too, by design since #933: recorded, not asserted.
      const secondKill = await provider.kill(sandbox.id).catch((error: unknown) => blStatus(error));
      const listedFor = await until(async () => !(await provider.list({ metadata: { runId, slot: "a" } })).length && Date.now() - killedAt, 60_000, 250);
      expect(listedFor, "still listed 60 s on");
      const states: string[] = [];
      const gone = await until(async () => {
        const status = await SandboxInstance.get(sandbox.id).then((got) => got.status ?? "?", (error) => blStatus(error));
        if (!states.at(-1)?.startsWith(status)) states.push(`${status}@${Date.now() - killedAt}ms`);
        return status.endsWith(" 404") || status === "TERMINATED";
      }, 60_000, 250);
      expect(gone, `get() never 404/TERMINATED: ${states.join(" > ")}`);
      const lastKill = await provider.kill(sandbox.id).catch((error: unknown) => blStatus(error));
      expect(lastKill === false, `a kill once gone: ${lastKill}`);
      return `measured: list empty ${listedFor} ms after kill; get(): ${states.join(" > ")}; second kill right away: ${secondKill}`;
    });
  });

  await withSandbox("c", SLOT_MS, async (sandbox) => {
    const dir = "/home/user/check-build-smoke";
    const disk: string[] = [];
    const sample = async (label: string) => { disk.push(`${label}: ${await df(sandbox)}`); };
    await sample("empty");
    await sandbox.writeFiles(NEXT_APP_STARTER.map((file) => ({ path: `${WORK_DIR}/${file.path}`, data: file.content })));
    await deadlineRow("Next starter npm install (boot route, streamed)", BOOT_INSTALL_MS, () =>
      timed(sandbox, DEFAULT_INSTALL_COMMAND, { cwd: WORK_DIR, timeoutMs: BOOT_INSTALL_MS }));
    await sample("after install");

    // check-build's copy path: node_modules copied next to the preview, then its install and build there.
    let stepMs = 0;
    await deadlineRow("check-build cp -a node_modules", COPY_TIMEOUT_MS, async () => {
      const timing = await timed(sandbox, `mkdir -p ${dir} && cp -a ${WORK_DIR}/node_modules ${dir}/`, { timeoutMs: COPY_TIMEOUT_MS }, false);
      stepMs += timing.wallMs;
      return timing;
    });
    await sample("after copy");
    await sandbox.writeFiles(NEXT_APP_STARTER.map((file) => ({ path: `${dir}/${file.path}`, data: file.content })));
    let checkMs = 0;
    await deadlineRow("check-build install in the copy", CHECK_TIMEOUT_MS, async () => {
      const timing = await timed(sandbox, offlineFirstInstall("--no-audit --no-fund --loglevel=error"), { cwd: dir, timeoutMs: CHECK_TIMEOUT_MS }, false);
      checkMs += timing.wallMs;
      return timing;
    });
    await deadlineRow("check-build next build (its Next command)", CHECK_TIMEOUT_MS, async () => {
      const timing = await timed(sandbox, "NEXT_TELEMETRY_DISABLED=1 npx next build", { cwd: dir, timeoutMs: CHECK_TIMEOUT_MS }, false);
      checkMs += timing.wallMs;
      return timing;
    });
    stepMs += checkMs;
    await sample("after next build");
    await check(`a check-build install + build within CHECK_TIMEOUT_MS ${seconds(CHECK_TIMEOUT_MS)}, step within ${seconds(STEP_BUDGET_MS)}`, async () => {
      expect(checkMs > 0 && checkMs <= CHECK_TIMEOUT_MS, `install + build ${seconds(checkMs)}`);
      expect(stepMs <= STEP_BUDGET_MS, `copy + install + build ${seconds(stepMs)}`);
      return `install + build ${seconds(checkMs)}; copy + install + build ${seconds(stepMs)}`;
    });
    await deadlineRow("npx tsc --noEmit in the Next starter (Vite's check-build step; indicative)", CHECK_TIMEOUT_MS, () =>
      timed(sandbox, "npx tsc --noEmit", { cwd: dir, timeoutMs: CHECK_TIMEOUT_MS }));
    await measure("9 disk and memory through a Next starter install, check-build's copy and next build (disk is RAM-backed)", async () => {
      const { stdout } = await sandbox.run(`du -sh ${WORK_DIR}/node_modules ${dir}/node_modules ${dir}/.next 2>/dev/null | cut -f1 | tr '\\n' ' '; findmnt -no FSTYPE,SIZE -T /home/user; dmesg 2>/dev/null | grep -ci 'out of memory'`);
      return `${disk.join(" || ")} || node_modules, copy, .next, fs: ${stdout.trim().replace(/\s+/g, " ")}`;
    });
  });

  await withSandbox("d", 2 * 60_000, async (sandbox) => {
    await check("e a 2-minute date policy deletes the sandbox on time", async () => {
      const endAt = (await sandbox.info()).endAt.getTime();
      expect(endAt > Date.now(), `endAt ${new Date(endAt).toISOString()} is not in the future`);
      const states: string[] = [];
      const gone = await until(async () => {
        const status = await SandboxInstance.get(sandbox.id).then((got) => got.status ?? "?", (error) => blStatus(error));
        const at = Math.round((Date.now() - endAt) / 1000);
        if (!states.at(-1)?.startsWith(status)) states.push(`${status}@${at >= 0 ? "+" : ""}${at}s`);
        return (status.endsWith(" 404") || status === "TERMINATED" || status === "DELETING") && Date.now();
      }, 5 * 60_000, 2000);
      expect(gone, `still there 3 minutes after endAt: ${states.join(" > ")}`);
      expect(gone >= endAt - 5_000, `deleted ${Math.round((endAt - gone) / 1000)} s before endAt: not by the policy`);
      expect(gone - endAt <= 60_000, `deleted ${Math.round((gone - endAt) / 1000)} s after endAt`);
      return `relative to endAt: ${states.join(" > ")}`;
    });
  });
} catch (error) {
  record("run", false, error instanceof Error ? error.message : String(error));
} finally {
  // The SDK's HTTP/2 sessions can keep the event loop alive.
  process.exit(await finish());
}
