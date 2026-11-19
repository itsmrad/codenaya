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
 */
import { SandboxInstance, getBlaxelErrorStatus } from "@blaxel/core";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { NEXT_APP_STARTER } from "../../src/features/conversations/inngest/next-starter";
import { VITE_REACT_STARTER } from "../../src/features/conversations/inngest/vite-starter";
import {
  DEV_COMMAND_ENV, DEV_SERVER_ENVS, PREVIEW_PROXY_PORT, PROXY_SCRIPT_PATH, PROXY_TARGET_ENV, isPortOpen, runDevServer,
} from "../../src/features/sandbox-preview/server/dev-server";
import { createBlaxelProvider } from "../../src/features/sandbox-preview/server/provider/blaxel";
import { killTree, listCommands, listProcesses } from "../../src/features/sandbox-preview/server/provider/helpers";
import {
  type Sandbox, SandboxConfigError, SandboxNotFoundError, SandboxTimeoutError,
} from "../../src/features/sandbox-preview/server/provider/types";
import { appendHostFlag, detectFrameworkFromFiles } from "../../src/features/sandbox-preview/utils/dev-command";
import {
  BROWSER, createSmoke, describe, errorName, expect, get, openHmr, proxySource, refuse, requireDevConfirmation, sleep, until,
} from "./harness";

const env = process.env;
requireDevConfirmation("creates live Blaxel sandboxes, about $0.05");
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

const SLOT_MS = 10 * 60_000;
const APP = "/home/user/app";
const GATE_PORT = 4101;
const BLAXEL = /blaxel/i;

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

/** The control plane's view: status, standby state, events and lifecycle (a read; assumed not to resume). */
async function rawView(id: string) {
  const sandbox = await SandboxInstance.get(id);
  const { state } = (sandbox as unknown as { sandbox: { state?: string } }).sandbox;
  const events = sandbox.events ?? [];
  return {
    status: sandbox.status, state, createdAt: sandbox.metadata.createdAt, updatedAt: sandbox.metadata.updatedAt,
    events: events.length, lastEvent: events.at(-1)?.status, policy: sandbox.spec.lifecycle?.expirationPolicies?.map(({ value }) => value).join(","),
  };
}
const elapsed = (from: number) => `${((Date.now() - from) / 1000).toFixed(1)} s`;
/** The latest endAt the backstop allows: 15 minutes from the server's createdAt. */
const hardEndOf = async (id: string) => Date.parse((await SandboxInstance.get(id)).metadata.createdAt ?? "") + LIFETIME_MS;

/** What updateLifecycle must not lose: the process, its port, a file and the VM's boot. */
async function fingerprint(sandbox: Sandbox, pid: number, port: number) {
  const { stdout } = await sandbox.run(
    `test -d /proc/${pid} && echo alive; curl -s -m 5 localhost:${port}; echo; cat /home/user/gate/keep.txt; echo; ` +
    "cat /proc/sys/kernel/random/boot_id; cut -d' ' -f1 /proc/uptime",
  );
  const [alive, served, file, boot, uptime] = stdout.split("\n");
  return { alive: alive === "alive", served, file, boot, uptime: Number(uptime) };
}

/** connect({ timeoutMs }) never shortens, then extends to the backstop; the endAt before and after. */
async function extend(sandbox: Sandbox) {
  const before = (await sandbox.info()).endAt.getTime();
  await provider.connect(sandbox.id, { timeoutMs: 60_000 });
  const unchanged = (await sandbox.info()).endAt.getTime();
  expect(unchanged === before, `a 1-minute connect moved endAt by ${unchanged - before} ms`);
  const hardEnd = await hardEndOf(sandbox.id);
  // Whole minutes, rounded down, so the new endAt stays inside the backstop.
  const minutes = Math.floor((hardEnd - Date.now()) / 60_000);
  expect(Date.now() + minutes * 60_000 > before, "no room to extend within the backstop");
  const startedAt = Date.now();
  await provider.connect(sandbox.id, { timeoutMs: minutes * 60_000 });
  const connectMs = Date.now() - startedAt;
  const after = (await sandbox.info()).endAt.getTime();
  expect(after > before && after <= hardEnd + 5_000, `endAt moved ${after - before} ms; ${after - hardEnd} ms past the backstop`);
  return { before, after, connectMs };
}

const blocker = (name: string, detail: string) => {
  log({ event: "blocker", name, detail });
  console.error(`\n*** BLOCKER (#911 gate): ${name}: ${detail}\n`);
};

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
      }, 30_000, 1000) ?? [];
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
    await measure("1b raw: stored labels, createdAt, lifecycle on listed items, q case sensitivity", async () => {
      const view = await rawView(sandbox.id);
      expect(view.createdAt, "get() has no metadata.createdAt");
      const byQ = async (q: string) => (await SandboxInstance.list({ q, limit: 50 })).data.filter((item) => item.metadata.name === sandbox.id);
      const [mixed] = await byQ(meta.userId);
      const lower = await byQ(meta.userId.toLowerCase());
      const share = await byQ(meta.publicShare);
      return `get: ${JSON.stringify(view)}; q=userId finds it: ${Boolean(mixed)}, q=lowercased: ${lower.length > 0}, ` +
        `q=publicShare: ${share.length > 0}; listed spec.lifecycle: ${JSON.stringify(mixed?.spec.lifecycle ?? null)}; ` +
        `listed expiresIn ${mixed?.expiresIn ?? "-"} s`;
    });

    // The #911 gate, first, so a redeploy shows before anything else depends on the sandbox.
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
      const { before: endBefore, after: endAfter, connectMs } = await extend(sandbox);
      const viewAfter = await rawView(sandbox.id);
      const now = await fingerprint(sandbox, gatePid, GATE_PORT);
      // A redeploy could land a little later: look again after 20 s.
      await sleep(20_000);
      const later = await fingerprint(sandbox, gatePid, GATE_PORT);
      const viewLater = await rawView(sandbox.id);
      const kept = [now, later].every((print) =>
        print.alive && print.served === "gate-ok" && print.file === "kept" && print.boot === before.boot && print.uptime > before.uptime);
      const detail = `before ${JSON.stringify(before)} ${JSON.stringify(viewBefore)} | after ${JSON.stringify(now)} ${JSON.stringify(viewAfter)} | ` +
        `+20 s ${JSON.stringify(later)} ${JSON.stringify(viewLater)}`;
      if (!kept) blocker("updateLifecycle lost the sandbox's state", detail);
      expect(kept, detail);
      return `pid ${gatePid} kept, same boot, uptime ${before.uptime} -> ${later.uptime} s; endAt +${Math.round((endAfter - endBefore) / 1000)} s ` +
        `(connect ${connectMs} ms); status ${viewBefore.status}/${viewBefore.state} -> ${viewAfter.status}/${viewAfter.state} -> ` +
        `${viewLater.status}/${viewLater.state}; events ${viewBefore.events} -> ${viewLater.events}; ` +
        "the createdAt + 1 h clamp is unit-tested only (a live check would lift the 15-minute backstop)";
    });

    await check("2a exit 3 is a result; stdout/stderr separate, sync and streamed", async () => {
      const sync = await sandbox.run("echo out; echo err >&2; exit 3");
      expect(sync.exitCode === 3 && sync.stdout.trim() === "out" && sync.stderr.trim() === "err", `sync ${JSON.stringify(sync)}`);
      const streamed = await sandbox.run("echo out; echo err >&2; exit 3", { onStdout: () => {} });
      expect(streamed.exitCode === 3 && streamed.stdout.trim() === "out" && streamed.stderr.trim() === "err", `streamed ${JSON.stringify(streamed)}`);
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
    await measure("2b' raw: the status and exit code of a command its timeout killed", async () => {
      const raw = await SandboxInstance.get(sandbox.id);
      const result = await raw.process.exec({ command: "sleep 6", waitForCompletion: true, timeout: 2, onStdout: () => {} });
      return `status ${result.status}, exitCode ${result.exitCode}`;
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
      expect(silent.exitCode === 0 && silent.stdout.trim() === "done", `silent ${JSON.stringify(silent)}`);
      expect(streamed.exitCode === 0 && ticks === 15, `streamed exit ${streamed.exitCode}, ${ticks} ticks`);
      return elapsed(started);
    });
    await check("2d cwd and env are applied, values with ' and $", async () => {
      const value = "a b'c $HOME $(id) \"q\"";
      const result = await sandbox.run(`pwd; printf '%s' "$SMOKE_VAR"`, { cwd: "/tmp", envs: { SMOKE_VAR: value } });
      // Trailing newlines are 2g's question.
      expect(result.stdout.replace(/\n$/, "") === `/tmp\n${value}`, JSON.stringify(result.stdout));
    });
    await check("2g stdout comes back byte-exact (no added or lost newline), sync and streamed", async () => {
      const cases = ["x", "x\n", "a\n\nb\n"];
      const got: string[] = [];
      for (const expected of cases) {
        const command = `printf '${expected.replaceAll("\n", "\\n")}'`;
        for (const opts of [{}, { onStdout: () => {} }]) {
          const { stdout } = await sandbox.run(command, opts);
          if (stdout !== expected) got.push(`${command} -> ${JSON.stringify(stdout)}`);
        }
      }
      expect(!got.length, got.join("; "));
    });
    await check("2h output over 64 KB comes back whole, many lines and one long line", async () => {
      const lines = Array.from({ length: 30_000 }, (_, index) => index + 1).join("\n");
      const many = (await sandbox.run("seq 1 30000")).stdout.replace(/\n$/, "");
      const long = (await sandbox.run("head -c 100000 /dev/zero | tr '\\0' a", { onStdout: () => {} })).stdout.replace(/\n$/, "");
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
      const blaxelEnv = Object.keys(root.envs).filter((key) => /^BL_/.test(key)).join(",");
      expect((await killTree(sandbox, pid)).exitCode === 0, "killTree failed");
      expect(await until(async () => (await sandbox.run(`test -d /proc/${pid}`)).exitCode !== 0, 10_000), "alive after killTree");
      return `pid ${pid} (${root.cmd} ${root.args.slice(0, 1).join(" ")}); BL_ env names inherited: ${blaxelEnv || "none"}; streamed ${JSON.stringify(output)}`;
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
    await check("4b 1000 files and a 2 MB file in one writeFiles", async () => {
      const started = Date.now();
      const big = "0123456789abcdef".repeat(128 * 1024);
      await sandbox.writeFiles([
        ...Array.from({ length: 1000 }, (_, index) => ({ path: `/home/user/many/d${index % 10}/f${index}.txt`, data: `${index}` })),
        { path: "/home/user/many/big.txt", data: big },
      ]);
      const { stdout } = await sandbox.run("find /home/user/many -type f | wc -l; wc -c < /home/user/many/big.txt");
      expect(stdout.split("\n").slice(0, 2).join(" ") === `1001 ${big.length}`, stdout);
      return `measured: ${Date.now() - started} ms`;
    });
    await check("4c readFile of a missing file is not SandboxNotFoundError", async () => {
      const error = await sandbox.readFile("/home/user/nope.txt", "text").then(() => undefined, (caught: unknown) => caught);
      expect(error && !(error instanceof SandboxNotFoundError), `got ${error ? blStatus(error) : "no error"}`);
      return blStatus(error);
    });
    await check("6a' the gate server, its file and the boot are unchanged at the end of the slot", async () => {
      expect(gatePid, "no gate server (6a failed)");
      const print = await fingerprint(sandbox, gatePid, GATE_PORT);
      expect(print.alive && print.served === "gate-ok" && print.file === "kept" && print.boot === gateBoot, JSON.stringify(print));
      return `${elapsed(createdAt)} after create`;
    });

    await check("8a kill; list empties; connect throws NotFound; a second kill is false", async () => {
      expect(await provider.kill(sandbox.id) === true, "kill did not report true");
      const killedAt = Date.now();
      const statusRightAfter = await SandboxInstance.get(sandbox.id).then((got) => got.status, (error) => blStatus(error));
      const connect = await provider.connect(sandbox.id).then(() => "connected", (error: unknown) => error);
      expect(connect instanceof SandboxNotFoundError, `connect after kill: ${connect instanceof Error ? blStatus(connect) : connect}`);
      const secondKill = await provider.kill(sandbox.id).catch((error: unknown) => blStatus(error));
      expect(secondKill === false, `second kill: ${secondKill}`);
      expect(await until(async () => !(await provider.list({ metadata: { runId, slot: "a" } })).length, 60_000, 1000), "still listed 60 s on");
      return `measured: list empty ${elapsed(killedAt)} after kill; get() right after: ${statusRightAfter}`;
    });
    await measure("8b get() and a second kill while the sandbox goes", async () => {
      const started = Date.now();
      const states: string[] = [];
      await until(async () => {
        const status = await SandboxInstance.get(sandbox.id).then((got) => got.status ?? "?", (error) => blStatus(error));
        if (!states.at(-1)?.startsWith(status)) states.push(`${status}@${Math.round((Date.now() - started) / 1000)}s`);
        return status.endsWith(" 404") || status === "TERMINATED";
      }, 60_000, 2000);
      const kill = await provider.kill(sandbox.id).catch((error: unknown) => blStatus(error));
      return `get(): ${states.join(" > ")}; provider.kill once gone: ${kill}`;
    });
  });

  await withSandbox("b", SLOT_MS, async (sandbox) => {
    let previewUrl = "";
    let hmrUrl: URL | undefined;
    const proxyRoot = async () => (await listCommands(sandbox)).find((command) => command.envs[PROXY_TARGET_ENV]);
    const devRoot = async () => (await listCommands(sandbox)).find((command) => command.envs[DEV_COMMAND_ENV]);
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

    await check("5a the Vite starter boots behind the :4000 proxy; previewUrl answers a server-side fetch", async () => {
      await sandbox.writeFiles(VITE_REACT_STARTER.map((file) => ({ path: `${APP}/${file.path}`, data: file.content })));
      const install = await sandbox.run("npm install --prefer-offline --no-audit --no-fund", { cwd: APP, timeoutMs: 300_000 });
      expect(install.exitCode === 0, `npm install exited ${install.exitCode}: ${install.stderr.slice(-200)}`);
      const command = appendHostFlag("npm run dev", detectFrameworkFromFiles([...VITE_REACT_STARTER]));
      await runDevServer(sandbox, { command, cwd: APP, envs: { ...DEV_SERVER_ENVS } });
      expect(await until(() => isPortOpen(sandbox, 5173), 60_000, 1500), "Vite did not open :5173");
      await startProxy();
      const started = Date.now();
      previewUrl = await sandbox.previewUrl(PREVIEW_PROXY_PORT);
      // The edge can answer 5xx until it routes the new port, as route.ts waitForPublicUrl allows.
      const status = await until(async () => {
        const response = await get(previewUrl).catch(() => undefined);
        await response?.body?.cancel();
        return response && response.status < 500 ? response.status : undefined;
      }, 30_000, 1000);
      expect(status === 200, `status ${status}`);
      const page = await describe(previewUrl, {}, BLAXEL);
      expect(page.vite, `not the Vite page: ${JSON.stringify(page)}`);
      const host = new URL(previewUrl).hostname;
      return `200 ${elapsed(started)} after previewUrl; host shape ${host.replace(/^[^.]+/, "<hash>")}; same URL again: ${await sandbox.previewUrl(PREVIEW_PROXY_PORT) === previewUrl}`;
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
        await sandbox.writeFiles([{ path: `${APP}/src/App.tsx`, data: `${app.content}\n// smoke edit\n` }]);
        await hmr.next("update", 20_000, from).catch(() => hmr.next("full-reload", 1, from));
      } finally {
        hmr.close();
      }
    });
    await check("5d HMR reconnects after a forced close: client-side, and the proxy killed in the sandbox", async () => {
      await connected();
      const hmr = openHmr(hmrUrl!);
      try {
        await hmr.next("connected", 15_000);
        const proxy = await proxyRoot();
        expect(proxy, "the proxy is not listed");
        await killTree(sandbox, proxy.pid);
        expect(await until(() => hmr.isClosed(), 15_000), "the socket stayed open after the proxy died");
      } finally {
        hmr.close();
      }
      await startProxy();
      await connected();
    });
    await measure("5e a preview of a port not declared at create (:5173 directly)", async () => {
      const url = await sandbox.previewUrl(5173);
      const status = await until(async () => {
        const response = await get(url).catch(() => undefined);
        await response?.body?.cancel();
        return response && response.status < 500 ? response.status : undefined;
      }, 20_000, 1000);
      return `status ${status ?? "5xx/none after 20 s"}`;
    });

    await check("6b GATE on a live preview: connect extends and the dev server, proxy, preview and HMR survive", async () => {
      expect(previewUrl, "no preview (5a failed)");
      const [dev, proxy] = [await devRoot(), await proxyRoot()];
      expect(dev && proxy, "no dev server or proxy root");
      const { before, after } = await extend(sandbox);
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
        const { status, state, lastEvent } = await rawView(sandbox.id);
        const now = `${status}/${state ?? "-"}`;
        if (!states.at(-1)?.startsWith(now)) states.push(`${now}@${Math.round((Date.now() - started) / 1000)}s (${lastEvent ?? "-"})`);
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
  });

  await withSandbox("c", SLOT_MS, async (sandbox) => {
    await measure("9 disk and memory after a Next.js starter install (Blaxel's disk is in RAM)", async () => {
      const dir = "/home/user/next-app";
      const df = async () => (await sandbox.run("df -h /home/user | tail -1; free -m | sed -n 2p")).stdout.trim().replaceAll("\n", " | ");
      const before = await df();
      await sandbox.writeFiles(NEXT_APP_STARTER.map((file) => ({ path: `${dir}/${file.path}`, data: file.content })));
      const started = Date.now();
      const install = await sandbox.run("npm install --prefer-offline --no-audit --no-fund", { cwd: dir, timeoutMs: 600_000 });
      expect(install.exitCode === 0, `npm install exited ${install.exitCode}: ${install.stderr.slice(-200)}`);
      const size = (await sandbox.run(`du -sh ${dir}/node_modules | cut -f1; findmnt -no FSTYPE -T /home/user`)).stdout.trim().replaceAll("\n", " ");
      return `before: ${before} || after (${elapsed(started)} install, node_modules + fs ${size}): ${await df()}`;
    });
  });
} catch (error) {
  record("run", false, error instanceof Error ? error.message : String(error));
} finally {
  // The SDK's HTTP/2 sessions can keep the event loop alive.
  process.exit(await finish());
}
