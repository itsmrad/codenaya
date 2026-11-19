/**
 * Bounded live smoke test of the Daytona adapter (SANDBOX lane D5). Dev only.
 *
 *   SANDBOX_SMOKE_CONFIRM=1 infisical run --env dev -- npm run smoke:daytona
 *
 * It goes through the seam (`createDaytonaProvider`); the raw SDK is used only to read
 * what the seam hides (state, auto-stop, sessions, a second delete). Guards: at most 3
 * sandboxes, one at a time, each with a TTL of 15 minutes or less (Daytona deletes it even
 * if this script dies) and killed by id in a finally. Every create, kill and check goes to
 * SANDBOX_SMOKE_LOG (JSONL). It stops once the logged estimate, across that file's runs, would pass $1
 * (the cap is per log file). The dev check is a proxy: a dev Convex URL means an `infisical --env dev`
 * shell, so the Daytona key is the dev org's; the API host is logged at start.
 */
import { Daytona } from "@daytona/sdk";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { VITE_REACT_STARTER } from "../../src/features/conversations/inngest/vite-starter";
import {
  DEV_COMMAND_ENV, DEV_SERVER_ENVS, PREVIEW_PROXY_PORT, PROXY_SCRIPT_PATH, PROXY_TARGET_ENV,
  findPreviewDevServer, isPortOpen, restartDevServerIfDown, runDevServer,
} from "../../src/features/sandbox-preview/server/dev-server";
import { createDaytonaProvider } from "../../src/features/sandbox-preview/server/provider/daytona";
import { killTree, listCommands, listProcesses } from "../../src/features/sandbox-preview/server/provider/helpers";
import { parsePublicSandboxIdOrNull } from "../../src/features/sandbox-preview/server/provider/ids";
import { SandboxConfigError, SandboxNotFoundError, SandboxTimeoutError } from "../../src/features/sandbox-preview/server/provider/types";
import { appendHostFlag, detectFrameworkFromFiles } from "../../src/features/sandbox-preview/utils/dev-command";
import {
  BROWSER, createSmoke, describe, expect, get, openHmr, proxySource, refuse, requireDevConfirmation, sleep, statusOf, until,
} from "./harness";

const env = process.env;
requireDevConfirmation("creates live Daytona sandboxes, about $0.05");
const apiKey = env.DAYTONA_API_KEY?.trim() ?? "";
if (!apiKey) refuse("DAYTONA_API_KEY must be set");

const provider = createDaytonaProvider(apiKey);
// Raw reads only; the same endpoint the adapter defaults to.
const apiUrl = env.DAYTONA_API_URL?.trim() || "https://app.daytona.io/api";
const raw = new Daytona({ apiKey, apiUrl });

// A child with VERCEL=1, so the SDK takes its serverless upload and log-stream branches (#907 U19).
if (process.argv[2] === "--serverless-probe") {
  const sandbox = await provider.connect(process.argv[3]);
  const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
  await sandbox.writeFiles([{ path: "/tmp/sl/a.txt", data: "sl ✓" }, { path: "/tmp/sl/b.bin", data: bytes.buffer }]);
  const back = await sandbox.readFile("/tmp/sl/b.bin", "bytes");
  let streamed = "";
  const result = await sandbox.run("echo one; sleep 1; echo two", { onStdout: (data) => { streamed += data; } });
  console.log(JSON.stringify({ text: await sandbox.readFile("/tmp/sl/a.txt", "text"), bytes: back.length, streamed, exit: result.exitCode }));
  process.exit(0);
}

const SLOT_B_MS = 10 * 60_000;
const APP = "/home/user/app";
const DAYTONA = /daytona/i;

const { runId, meta, log, LIFETIME_MS, record, withSandbox, finish, check, measure } = createSmoke({
  vendor: "daytona", provider,
  // 2 vCPU x $0.0504/h + 2 GiB x $0.0162/h, disk within the free 5 GiB (the snapshot's resources).
  usdPerHour: 0.1332, rateNote: "active s x $0.1332/h, 2 vCPU/2 GiB list price",
  /**
   * Every labelled sandbox in any state (raw list, no state filter) and every id it created,
   * read back one by one.
   */
  async sweep(runId, everCreated, log) {
    try {
      const ids = new Set(everCreated);
      for await (const listed of raw.list({ labels: { runId } })) if (listed.labels?.runId === runId) ids.add(listed.id);
      let leftovers = 0;
      for (const id of ids) {
        const state = await raw.get(id).then((got) => got.state ?? "unknown", (error) => statusOf(error));
        if (state.endsWith(" 404") || state === "destroyed" || state === "destroying") continue;
        leftovers++;
        const deleted = await raw.get(id).then((got) => got.delete()).then(() => true, (error) => statusOf(error));
        log({ event: "sweep-kill", id, state, deleted });
      }
      return leftovers;
    } catch (error) {
      log({ event: "sweep-failed", error: statusOf(error) });
      return null;
    }
  },
});

log({ event: "start", apiHost: new URL(apiUrl).host });
try {
  await check("7b a bad DAYTONA_API_KEY raises SandboxConfigError", async () => {
    const error = await createDaytonaProvider("dtn_smoke_invalid_key").list({ metadata: { runId }, limit: 1 }).catch((caught: unknown) => caught);
    expect(error instanceof SandboxConfigError, `got ${statusOf(error)}`);
    return statusOf((error as Error).cause);
  });

  await withSandbox("a", LIFETIME_MS, async (sandbox) => {
    await check("1 labels round-trip; a subset filter lists it; another user lists none; endAt is set", async () => {
      const info = await sandbox.info();
      for (const [key, value] of Object.entries(meta)) expect(info.metadata[key] === value, `info lost ${key}`);
      expect(!("code-toolbox-language" in info.metadata), "the SDK label leaked into metadata");
      const listed = await until(async () => {
        const found = await provider.list({ metadata: { userId: meta.userId, runId } });
        return found.length ? found : undefined;
      }, 15_000) ?? [];
      expect(listed.length === 1 && listed[0].id === sandbox.id, `list returned ${listed.length}`);
      for (const [key, value] of Object.entries(meta)) expect(listed[0].metadata[key] === value, `list lost ${key}`);
      expect(listed[0].endAt.getTime() > Date.now(), "listed endAt is not in the future");
      const other = await provider.list({ metadata: { userId: meta.userId.toLowerCase(), runId } });
      expect(other.length === 0, `another user listed ${other.length}`);
      expect(parsePublicSandboxIdOrNull(sandbox.id), `id ${sandbox.id} fails NATIVE_ID`);
      const { autoStopInterval, cpu, memory, disk } = await raw.get(sandbox.id);
      expect(autoStopInterval === 0, `autoStopInterval ${autoStopInterval}`);
      return `id ${sandbox.id}; endAt in ${Math.round((info.endAt.getTime() - Date.now()) / 1000)} s; autoStop 0; ${cpu} vCPU/${memory} GiB/${disk} GiB`;
    });

    await check("2a exit 3 is a result; stdout/stderr separate, sync and streamed", async () => {
      const sync = await sandbox.run("echo out; echo err >&2; exit 3");
      expect(sync.exitCode === 3 && sync.stdout.trim() === "out" && sync.stderr.trim() === "err", `sync ${JSON.stringify(sync)}`);
      const started = Date.now();
      const streamed = await sandbox.run("echo out; echo err >&2; exit 3", { onStdout: () => {} });
      expect(streamed.exitCode === 3 && streamed.stdout.trim() === "out" && streamed.stderr.trim() === "err", `streamed ${JSON.stringify(streamed)}`);
      return `measured: the streamed run returned in ${Date.now() - started} ms (the log follow closes on exit)`;
    });
    await check("2b timeoutMs 2000 on sleep 5 throws SandboxTimeoutError and the process is gone", async () => {
      const started = Date.now();
      const error = await sandbox.run("sleep 5", { timeoutMs: 2000 }).then(() => undefined, (caught: unknown) => caught);
      expect(error instanceof SandboxTimeoutError, `got ${error ? statusOf(error) : "no error"}`);
      const elapsed = Date.now() - started;
      const left = (await listProcesses(sandbox)).filter((process) => /sleep$/.test(process.cmd) && process.args[0] === "5");
      expect(!left.length, `sleep 5 still running: ${left.map((process) => process.pid)}`);
      return `after ${elapsed} ms`;
    });
    await check("2c 150 s commands, sync and streamed at once, both complete", async () => {
      let ticks = 0;
      const started = Date.now();
      const [sync, streamed] = await Promise.all([
        sandbox.run("sleep 150; echo done", { timeoutMs: 200_000 }),
        sandbox.run("for i in $(seq 1 15); do echo tick; sleep 10; done", {
          timeoutMs: 200_000, onStdout: (data) => { ticks += data.split("tick").length - 1; },
        }),
      ]);
      expect(sync.exitCode === 0 && sync.stdout.trim() === "done", `sync ${JSON.stringify(sync)}`);
      expect(streamed.exitCode === 0 && ticks === 15, `streamed exit ${streamed.exitCode}, ${ticks} ticks`);
      return `${Math.round((Date.now() - started) / 1000)} s`;
    });
    await check("2d cwd and env are applied, values with ' and $", async () => {
      const value = "a b'c $HOME $(id) \"q\"";
      const result = await sandbox.run(`pwd; printf '%s' "$SMOKE_VAR"`, { cwd: "/tmp", envs: { SMOKE_VAR: value } });
      // Line endings are 2g's question.
      expect(result.stdout.replace(/\n$/, "") === `/tmp\n${value}`, JSON.stringify(result.stdout));
    });
    await check("2g stdout comes back byte-exact (no added trailing newline), sync and streamed", async () => {
      const sync = (await sandbox.run("printf x")).stdout;
      const streamed = (await sandbox.run("printf x", { onStdout: () => {} })).stdout;
      expect(sync === "x" && streamed === "x", `sync ${JSON.stringify(sync)}, streamed ${JSON.stringify(streamed)}`);
    });
    await measure("2e run latency p50 over 10, and 3 concurrent runs", async () => {
      const times: number[] = [];
      for (let index = 0; index < 10; index++) {
        const started = Date.now();
        await sandbox.run("true");
        times.push(Date.now() - started);
      }
      const parallel = await Promise.all([1, 2, 3].map((n) => sandbox.run(`echo ${n}`)));
      expect(parallel.every((result, index) => result.stdout.trim() === String(index + 1)), "a concurrent run mixed output");
      times.sort((a, b) => a - b);
      return `p50 ${times[4]} ms, max ${times[9]} ms`;
    });
    await check("2f the image: shell, user, home, node, tools on PATH, egress", async () => {
      const { stdout } = await sandbox.run(
        'echo "$0 $(whoami) $HOME $(node -v)"; for t in bash timeout sha256sum base64 curl; do command -v $t >/dev/null || echo "missing $t"; done; ' +
        'for u in https://registry.npmjs.org/ https://example.com/ https://httpbin.org/get; do echo "$u $(curl -s -o /dev/null -m 10 -w %{http_code} $u)"; done',
        { timeoutMs: 60_000 },
      );
      expect(/ user \/home\/user v22\./.test(stdout) && !stdout.includes("missing"), stdout);
      // Tier-1 egress: the allowlist has npm, not arbitrary hosts.
      expect(/registry\.npmjs\.org\/ 200/.test(stdout), `npm not reachable: ${stdout}`);
      expect(!/example\.com\/ 200|httpbin\.org\/get 200/.test(stdout), `egress is not allowlisted: ${stdout}`);
      return stdout.replaceAll("\n", "; ");
    });

    await check("3 start: log streams after start returns; the pid is in /proc and is the marked root", async () => {
      let output = "";
      const { pid } = await sandbox.start(
        `node -e "require('http').createServer((q, s) => { console.log('hit'); s.end('ok'); }).listen(4100, () => console.log('smoke-listening'))"`,
        { envs: { [DEV_COMMAND_ENV]: "smoke-server" }, onStdout: (data) => { output += data; } },
      );
      expect(await until(() => output.includes("smoke-listening"), 15_000), "no streamed log");
      await sandbox.run("curl -s localhost:4100");
      expect(await until(() => output.includes("hit"), 10_000), "no log after start returned");
      expect((await sandbox.run(`test -d /proc/${pid}`)).exitCode === 0, `no /proc/${pid}`);
      const root = (await listCommands(sandbox)).find((command) => command.envs[DEV_COMMAND_ENV] === "smoke-server");
      expect(root?.pid === pid, `root pid ${root?.pid} != start pid ${pid}`);
      const daytonaEnv = Object.keys(root.envs).filter((key) => key.startsWith("DAYTONA")).join(",");
      expect((await killTree(sandbox, pid)).exitCode === 0, "killTree failed");
      expect(await until(async () => (await sandbox.run(`test -d /proc/${pid}`)).exitCode !== 0, 10_000), "alive after killTree");
      return `pid ${pid} (${root.cmd}); DAYTONA env names inherited: ${daytonaEnv || "none"}`;
    });

    await check("4a writeFiles text, binary and nested (sha256 manifest), readFile both formats", async () => {
      const text = "héllo ✓\n";
      const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
      await sandbox.writeFiles([
        { path: "/home/user/smoke/a.txt", data: text },
        { path: "/home/user/smoke/deep/er/b.bin", data: bytes.buffer },
      ]);
      expect(await sandbox.readFile("/home/user/smoke/a.txt", "text") === text, "text differs");
      const back = await sandbox.readFile("/home/user/smoke/deep/er/b.bin", "bytes");
      expect(back.length === 256 && back.every((byte, index) => byte === index), "bytes differ");
    });
    await check("4b 1000 files in one writeFiles", async () => {
      const started = Date.now();
      await sandbox.writeFiles(Array.from({ length: 1000 }, (_, index) => ({ path: `/home/user/many/d${index % 10}/f${index}.txt`, data: `${index}` })));
      const count = (await sandbox.run("find /home/user/many -type f | wc -l")).stdout.trim();
      expect(count === "1000", `${count} files`);
      return `measured: ${Date.now() - started} ms`;
    });
    await check("4c raw: uploadFiles into a missing dir; readFile of a missing file", async () => {
      const fs = (await raw.get(sandbox.id)).fs;
      const made = await fs.uploadFiles([{ source: Buffer.from("x"), destination: "/home/user/nodir/sub/x.txt" }]).then(
        async () => (await sandbox.run("test -f /home/user/nodir/sub/x.txt")).exitCode === 0, (error) => `rejected (${statusOf(error)})`);
      const missing = await sandbox.readFile("/home/user/nope.txt", "text").then(() => "no error", (error) => statusOf(error));
      expect(missing === "DaytonaFileNotFoundError 404", `missing read: ${missing}`);
      return `measured: upload makes parent dirs: ${made}`;
    });
    await measure("4d raw: the session shell, and whether deleteSession kills its command, also in run's end-marker shape", async () => {
      const { process: processes } = await raw.get(sandbox.id);
      const shell = await processes.createSession("smoke-shell")
        .then(() => processes.executeSessionCommand("smoke-shell", { command: "readlink /proc/$$/exe" }))
        .then((response) => response.stdout?.trim(), (error) => statusOf(error));
      const deleteKills = async (sessionId: string, command: string, arg: string) => {
        const running = async () => (await listProcesses(sandbox)).some((process) => /sleep$/.test(process.cmd) && process.args[0] === arg);
        await processes.createSession(sessionId);
        await processes.executeSessionCommand(sessionId, { command, runAsync: true });
        expect(await until(running, 5_000), `sleep ${arg} never started`);
        await processes.deleteSession(sessionId);
        return Boolean(await until(async () => !(await running()), 5_000));
      };
      const plain = await deleteKills("smoke-del", "sleep 301", "301");
      // run's wrapper since #920: no exec, so timeout (its own process group) is a child of the shell. A 60 s cap bounds a leak.
      const runShape = `bash -c 'env -- timeout -k 5 60s bash -c "sleep 302"; s=$?; printf %s%s a b; exit $s'`;
      const marked = await deleteKills("smoke-del-run", runShape, "302");
      return `session shell ${shell}; deleteSession kills its command: ${plain}; in run's shape: ${marked}`;
    });
    await check("4e VERCEL=1 child: serverless upload, read and log stream", async () => {
      // Async, so a signal isn't held up; the child's stderr is dropped, never logged.
      const args = [...process.execArgv, fileURLToPath(import.meta.url), "--serverless-probe", sandbox.id];
      const last = (stdout = "") => stdout.trim().split("\n").at(-1)?.slice(0, 200) ?? "";
      const output = await promisify(execFile)(process.execPath, args, { env: { ...env, VERCEL: "1" }, encoding: "utf8", timeout: 120_000 }).then(
        ({ stdout }) => last(stdout),
        (error: { code?: unknown; signal?: unknown; stdout?: string }) => {
          throw new Error(`child exit ${error.code ?? "-"}, signal ${error.signal ?? "-"}; last stdout: ${last(error.stdout)}`);
        },
      );
      const probe = JSON.parse(output || "{}");
      expect(probe.text === "sl ✓" && probe.bytes === 256 && probe.exit === 0, output);
      return `streamed ${JSON.stringify(probe.streamed)}`;
    });

    let stale: Awaited<ReturnType<typeof raw.get>> | undefined;
    await check("7a kill; list empties; connect throws NotFound", async () => {
      stale = await raw.get(sandbox.id);
      expect(await provider.kill(sandbox.id) === true, "kill did not report true");
      // list is eventually consistent: record how long it keeps a killed sandbox, and in what state.
      const killedAt = Date.now();
      // Each raw item's own state under the adapter's server filter, next to what provider.list returns (#920 review).
      const seen: string[] = [];
      for (let index = 0; index < 5; index++) {
        const items: string[] = [];
        for await (const item of raw.list({ labels: { runId, slot: "a" }, states: ["started"] })) items.push(String(item.state));
        seen.push(`raw [${items.join(",")}] adapter ${(await provider.list({ metadata: { runId, slot: "a" } })).length} @${Date.now() - killedAt}ms`);
      }
      const lagged = seen.join("; ");
      const lagState = await raw.get(sandbox.id).then((got) => got.state, (error) => statusOf(error));
      expect(await until(async () => !(await provider.list({ metadata: { runId, slot: "a" } })).length, 30_000, 1000), "still listed 30 s on");
      const listLag = `listed right after kill: ${lagged} (get(): ${lagState}); empty after ${Date.now() - killedAt} ms`;
      const connect = await provider.connect(sandbox.id).then(() => "connected", (error) => error);
      expect(connect instanceof SandboxNotFoundError, `connect after kill: ${statusOf(connect)}`);
      return `measured: ${listLag}`;
    });
    await measure("7c a second delete and kill, and get() while it goes", async () => {
      expect(stale, "no sandbox object (7a failed)");
      const secondDelete = await stale.delete().then(() => "resolved", (error) => statusOf(error));
      const secondKill = await provider.kill(sandbox.id);
      // How get() sees the sandbox while it goes, and when it 404s.
      const started = Date.now();
      const states: string[] = [];
      await until(async () => {
        const state = await raw.get(sandbox.id).then((got) => got.state ?? "?", (error) => statusOf(error));
        if (states.at(-1) !== state) states.push(`${state}@${Math.round((Date.now() - started) / 1000)}s`);
        return !state.includes("started") && !state.includes("destroying") && state !== "stopping";
      }, 60_000, 2000);
      return `raw second delete: ${secondDelete}; second provider.kill: ${secondKill}; get(): ${states.join(" > ")}`;
    });
  });

  await withSandbox("b", SLOT_B_MS, async (sandbox) => {
    let previewUrl = "";
    await check("5a the Vite starter boots behind the :4000 proxy; previewUrl answers a server-side fetch", async () => {
      await sandbox.writeFiles(VITE_REACT_STARTER.map((file) => ({ path: `${APP}/${file.path}`, data: file.content })));
      const install = await sandbox.run("npm install --prefer-offline --no-audit --no-fund", { cwd: APP, timeoutMs: 300_000 });
      expect(install.exitCode === 0, `npm install exited ${install.exitCode}: ${install.stderr.slice(-200)}`);
      const command = appendHostFlag("npm run dev", detectFrameworkFromFiles([...VITE_REACT_STARTER]));
      await runDevServer(sandbox, { command, cwd: APP, envs: { ...DEV_SERVER_ENVS } });
      expect(await until(() => isPortOpen(sandbox, 5173), 60_000, 1500), "Vite did not open :5173");
      await sandbox.writeFiles([{ path: PROXY_SCRIPT_PATH, data: proxySource(5173) }]);
      await sandbox.start(`node ${PROXY_SCRIPT_PATH}`, { envs: { [PROXY_TARGET_ENV]: "5173" } });
      expect(await until(() => isPortOpen(sandbox, PREVIEW_PROXY_PORT), 10_000), "the proxy did not open :4000");
      previewUrl = await sandbox.previewUrl(PREVIEW_PROXY_PORT);
      const status = await until(async () => {
        const response = await get(previewUrl).catch(() => undefined);
        await response?.body?.cancel();
        return response && response.status < 500 ? response.status : undefined;
      }, 30_000, 1000);
      expect(status === 200, `status ${status}`);
      // The interstitial is a 200 too, so check it is the Vite page.
      const page = await describe(previewUrl, {}, DAYTONA);
      expect(page.vite, `not the Vite page: ${JSON.stringify(page)}`);
      return `host ${new URL(previewUrl).hostname.replace(/^[^.]+/, "<port-id>")}`;
    });
    await check("5b interstitial: browser vs plain fetch vs the skip header; X-Frame-Options and CSP", async () => {
      expect(previewUrl, "no preview (5a failed)");
      const browser = await describe(previewUrl, BROWSER, DAYTONA);
      const plain = await describe(previewUrl, {}, DAYTONA);
      const skipped = await describe(previewUrl, { ...BROWSER, "x-daytona-skip-preview-warning": "true" }, DAYTONA);
      expect(browser.brand && !browser.vite, `a browser request did not get the interstitial: ${JSON.stringify(browser)}`);
      expect(plain.vite && skipped.vite, `a plain fetch or the skip header did not reach Vite`);
      return `browser ${JSON.stringify(browser)} | plain ${JSON.stringify(plain)} | skip ${JSON.stringify(skipped)}`;
    });
    await check("5c HMR WebSocket through the preview: connects and pushes an update", async () => {
      expect(previewUrl, "no preview (5a failed)");
      const skip = { "x-daytona-skip-preview-warning": "true" };
      const client = await (await get(new URL("/@vite/client", previewUrl), skip)).text();
      const token = /wsToken\s*=\s*"([^"]*)"/.exec(client)?.[1] ?? "";
      const url = new URL(`/?token=${encodeURIComponent(token)}`, previewUrl.replace(/^http/, "ws"));
      for (const path of ["/src/main.tsx", "/src/App.tsx"]) await (await get(new URL(path, previewUrl), skip)).body?.cancel();
      const hmr = openHmr(url);
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
    await check("5d restartDevServerIfDown through the /proc fallback", async () => {
      const found = await findPreviewDevServer(sandbox);
      expect(found, "no marked dev server and proxy");
      const dev = (await listCommands(sandbox)).find((command) => command.envs[DEV_COMMAND_ENV]);
      expect(dev, "no dev server root");
      await killTree(sandbox, dev.pid);
      expect(await until(async () => !(await isPortOpen(sandbox, 5173)), 10_000), ":5173 still open");
      expect(await restartDevServerIfDown(sandbox, found, 30_000), "it did not restart");
      expect(await until(() => isPortOpen(sandbox, 5173), 30_000, 1000), ":5173 did not reopen");
      return `restarted on :${found.port}`;
    });

    await check("6a connect({ timeoutMs }) extends, never shortens, stays within 15 min of now", async () => {
      const before = (await sandbox.info()).endAt.getTime();
      // The backstop holds: never past 15 minutes from creation (slot b starts with SLOT_B_MS).
      const hardEnd = before - SLOT_B_MS + LIFETIME_MS;
      await provider.connect(sandbox.id, { timeoutMs: 60_000 });
      const shorter = (await sandbox.info()).endAt.getTime();
      expect(shorter === before, `a 1-minute connect moved endAt by ${shorter - before} ms`);
      // Whole minutes, rounded down: the adapter rounds up.
      const minutes = Math.floor((hardEnd - Date.now()) / 60_000);
      expect(Date.now() + minutes * 60_000 > before, "no room to extend within the backstop");
      await provider.connect(sandbox.id, { timeoutMs: minutes * 60_000 });
      const after = (await sandbox.info()).endAt.getTime();
      expect(after > before && after <= hardEnd + 5_000, `endAt moved ${after - before} ms; ${after - hardEnd} ms past the backstop`);
      return `measured: +${Math.round((after - before) / 1000)} s; the createdAt + 1 h clamp is unit-tested only (a live check would lift the backstop)`;
    });
    await check("6b after 60 s idle, the preview and a run still answer; auto-stop is off", async () => {
      expect(previewUrl, "no preview (5a failed)");
      await sleep(60_000);
      const started = Date.now();
      const response = await get(previewUrl, { "x-daytona-skip-preview-warning": "true" });
      await response.body?.cancel();
      expect(response.status === 200, `status ${response.status}`);
      expect((await sandbox.run("true")).exitCode === 0, "run failed");
      const { state, autoStopInterval } = await raw.get(sandbox.id);
      expect(state === "started" && autoStopInterval === 0, `${state}, autoStop ${autoStopInterval}`);
      return `${Date.now() - started} ms`;
    });
  });

  await withSandbox("c", 60_000, async (sandbox) => {
    await check("6c a 1-minute TTL hard-deletes a started sandbox", async () => {
      const endAt = (await sandbox.info()).endAt.getTime();
      expect(endAt > Date.now(), `endAt ${new Date(endAt).toISOString()} is not in the future`);
      // A new sandbox takes a few seconds to appear in list, so wait for it before waiting for it to go.
      expect(await until(async () => (await provider.list({ metadata: { runId, slot: "c" } })).length, 30_000, 1000), "never listed");
      const gone = await until(() => raw.get(sandbox.id).then(() => false, (error) => statusOf(error).includes("404")), 4 * 60_000, 5000);
      expect(gone, "get() still finds it 4 minutes on");
      expect(Date.now() >= endAt - 5_000, `deleted ${Math.round((endAt - Date.now()) / 1000)} s before endAt: not by the TTL`);
      return `404 ${Math.round((Date.now() - endAt) / 1000)} s after endAt`;
    });
  });
} catch (error) {
  record("run", false, error instanceof Error ? error.message : String(error));
} finally {
  // The SDK's sockets can keep the event loop alive.
  process.exit(await finish());
}
