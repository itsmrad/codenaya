/**
 * What the live provider smokes (daytona.mts, blaxel.mts) share: the dev-only guards, the
 * JSONL log and its cost estimate, check/measure, one-sandbox-at-a-time `withSandbox`, the
 * sweep-and-summary wrap-up on every exit path, the sandbox budget block, and the :4000
 * proxy and HMR helpers. Vendor specifics (the raw sweep, the price) come in as config.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { PREVIEW_PROXY_PORT } from "../../src/features/sandbox-preview/server/dev-server";
import { rewriteProxyHeaders } from "../../src/features/sandbox-preview/server/preview-proxy";
import type { Sandbox, SandboxProvider } from "../../src/features/sandbox-preview/server/provider/types";
import { DEV_DEPLOYMENT, convexDeployment } from "../agent-eval/guard";

const env = process.env;

export const refuse = (why: string): never => {
  console.error(`Refusing to run: ${why}`);
  process.exit(2);
};

/** Exits unless confirmed, outside production and on the dev Convex deployment (a proxy for an `infisical --env dev` shell). */
export function requireDevConfirmation(what: string) {
  if (env.SANDBOX_SMOKE_CONFIRM !== "1") refuse(`set SANDBOX_SMOKE_CONFIRM=1 (${what})`);
  if (env.NODE_ENV === "production" || env.VERCEL_ENV) refuse("this looks like a production or Vercel environment");
  if (convexDeployment(env) !== DEV_DEPLOYMENT) refuse(`NEXT_PUBLIC_CONVEX_URL is not the ${DEV_DEPLOYMENT} dev deployment`);
  if (env.CONVEX_DEPLOYMENT?.startsWith("prod:")) refuse("CONVEX_DEPLOYMENT names a production deployment");
}

export const errorName = (error: unknown) => error instanceof Error ? error.name : typeof error;
/** The error's name and HTTP status (Daytona's `statusCode`, Blaxel's `status`). */
export const statusOf = (error: unknown) => {
  const { statusCode, status } = (error ?? {}) as { statusCode?: number; status?: number };
  return `${errorName(error)} ${statusCode ?? status ?? "-"}`;
};

const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export const alphanumeric = (length: number) => Array.from(randomBytes(length), (byte) => ALPHANUMERIC[byte % 62]).join("");

export const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
/** The probe's first truthy value, or undefined once `timeoutMs` passes. */
export async function until<T>(probe: () => T | Promise<T>, timeoutMs: number, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) return undefined;
    await sleep(everyMs);
  }
}
export const get = (url: string | URL, headers: Record<string, string> = {}) => fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
export function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// route.ts keeps its proxy private next to Next-only imports, so this is its HTTP and
// upgrade path with the same header rewrite, minus the error-bridge injection.
export const proxySource = (target: number) => `
const http = require('http'); const net = require('net');
const rewriteProxyHeaders = ${String(rewriteProxyHeaders)};
const server = http.createServer((req, res) => {
  const upstream = http.request({ hostname: 'localhost', port: ${target}, path: req.url, method: req.method,
    headers: rewriteProxyHeaders(req.headers, ${target}) }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  upstream.on('error', (err) => { if (!res.headersSent) res.writeHead(502); res.end(String(err)); });
  req.pipe(upstream);
});
server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect({ port: ${target}, host: 'localhost' }, () => {
    const h = rewriteProxyHeaders(req.headers, ${target});
    upstream.write(req.method + ' ' + req.url + ' HTTP/' + req.httpVersion + '\\r\\n' +
      Object.keys(h).map((k) => k + ': ' + h[k]).join('\\r\\n') + '\\r\\n\\r\\n');
    upstream.write(head); socket.pipe(upstream); upstream.pipe(socket);
  });
  upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
});
server.listen(${PREVIEW_PROXY_PORT}, '0.0.0.0');`;

/** Vite's HMR socket, through the public preview. */
export function openHmr(url: URL) {
  const socket = new WebSocket(url, "vite-hmr");
  const messages: { type?: string }[] = [];
  let closed = false;
  socket.addEventListener("message", (event) => {
    try { messages.push(JSON.parse(String(event.data))); } catch { /* not JSON */ }
  });
  socket.addEventListener("close", () => { closed = true; });
  return {
    close: () => socket.close(),
    isClosed: () => closed,
    /** Where `next` starts looking, so a message from before an edit can't satisfy it. */
    mark: () => messages.length,
    async next(type: string, timeoutMs: number, from = 0) {
      if (await until(() => messages.slice(from).some((message) => message.type === type), timeoutMs, 200)) return;
      throw new Error(`no "${type}" message; got [${messages.map((message) => message.type).join(",")}]${closed ? ", closed" : ""}`);
    },
  };
}

/** Status, framing headers and cookie names/attributes (values redacted) of one preview response; `brand` spots a vendor interstitial. */
export async function describe(url: string, headers: Record<string, string>, brand: RegExp) {
  const response = await get(url, headers);
  const body = await response.text();
  const cookies = response.headers.getSetCookie().map((cookie) => cookie.replace(/=[^;]*/, "=<redacted>"));
  return {
    status: response.status, vite: body.includes('id="root"'), brand: brand.test(body),
    type: response.headers.get("content-type"), xfo: response.headers.get("x-frame-options"),
    csp: response.headers.get("content-security-policy"), cookies,
  };
}
export const BROWSER = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

type Row = Record<string, unknown> & { event?: string; id?: string; estUsd?: number; est_usd?: number };
type Kind = "check" | "measure";

// Sandbox spend sits in its own block, so the top-level (Anthropic) entries and spent_usd stay untouched.
const APPEND_BUDGET = `
const fs = require("fs"), path = require("path");
const [file, raw] = process.argv.slice(1);
const entry = JSON.parse(raw), budget = JSON.parse(fs.readFileSync(file, "utf8"));
const lane = budget.sandbox ??= { cap_usd: 3, spent_usd: 0, entries: [], note: "SANDBOX lane live tests. Provider estimates, not invoices; not part of spent_usd." };
if (!lane.entries.some((e) => e.run === entry.run)) {
  lane.entries.push(entry);
  lane.spent_usd = Math.round((lane.spent_usd + entry.usd) * 1e6) / 1e6;
  const tmp = path.join(path.dirname(file), ".budget." + process.pid + ".tmp");
  fs.writeFileSync(tmp, JSON.stringify(budget, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
console.log("sandbox lane total $" + lane.spent_usd);`;

export interface SmokeConfig {
  vendor: string;
  provider: SandboxProvider;
  /** The list-price estimate per active hour of one sandbox. */
  usdPerHour: number;
  /** How `usdPerHour` was derived, for the budget entry. */
  rateNote: string;
  /** Deletes whatever the run left (labelled `runId`, or in `everCreated`); the leftover count, or null when it failed. */
  sweep: (runId: string, everCreated: ReadonlySet<string>, log: (row: Row) => void) => Promise<number | null>;
}

/**
 * The run's state and harness. Guards: at most 3 sandboxes, one at a time, each with a
 * provider-enforced lifetime of 15 minutes or less and killed by id in a finally. Every create,
 * kill and check goes to SANDBOX_SMOKE_LOG (JSONL), and it stops once the logged estimate,
 * across that file's runs, would pass $1 (the cap is per log file).
 */
export function createSmoke({ vendor, provider, usdPerHour, rateNote, sweep }: SmokeConfig) {
  const CAP_USD = 1;
  const LIFETIME_MS = 15 * 60_000;
  const MAX_SANDBOXES = 3;
  const WORST_CASE_USD = (LIFETIME_MS / 3_600_000) * usdPerHour;
  const LOG = resolve(env.SANDBOX_SMOKE_LOG ?? `claude/handoffs/sandbox/${vendor}-smoke.jsonl`);
  const BUDGET = resolve(env.SANDBOX_SMOKE_BUDGET ?? "claude/budget.json");

  // The sweep is scoped to this label, so it is unique per run.
  const runId = `smoke-${Date.now().toString(36)}-${alphanumeric(6)}`;
  // Real-shaped labels: a Clerk id (mixed case, underscore) and a long URL-safe share token.
  const meta = {
    userId: `user_${alphanumeric(27)}`, projectId: "smoke_project", purpose: "smoke", runId,
    publicShare: randomBytes(32).toString("base64url"),
  };

  mkdirSync(dirname(LOG), { recursive: true });
  const log = (row: Row) => appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), runId, ...row })}\n`);
  /** The log's rows; a line cut short by a crash mid-append is skipped. */
  const rows = (): Row[] => !existsSync(LOG) ? [] : readFileSync(LOG, "utf8").split("\n").flatMap((line) => {
    try { return line ? [JSON.parse(line)] : []; } catch { return []; }
  });
  /**
   * Each logged sandbox at its kill's estimate, or the full lifetime if never killed; a failed or
   * interrupted create too (an intent with no create row; either may have left one behind);
   * plus older rows' own estimates.
   */
  const estimateUsd = (only?: string) => {
    const logged = rows().filter((row) => !only || row.runId === only);
    const killed = new Map(logged.filter((row) => row.event === "kill").map((row) => [row.id, row.estUsd ?? WORST_CASE_USD]));
    const legacy = logged.reduce((sum, row) => sum + (row.event === "create-failed" ? WORST_CASE_USD : row.event ? 0 : row.est_usd ?? 0), 0);
    const answered = new Set(logged.filter((row) => row.event === "create" || row.event === "create-failed").map((row) => `${row.runId}/${row.slot}`));
    const interrupted = logged.filter((row) => row.event === "create-intent" && !answered.has(`${row.runId}/${row.slot}`)).length;
    return logged.filter((row) => row.event === "create")
      .reduce((sum, row) => sum + (killed.get(row.id) ?? WORST_CASE_USD), legacy + interrupted * WORST_CASE_USD);
  };
  const round = (usd: number) => Math.round(usd * 1e6) / 1e6;

  const results: { name: string; kind: Kind; pass: boolean; detail: string }[] = [];
  const record = (name: string, pass: boolean, detail = "", kind: Kind = "check") => {
    const text = detail.slice(0, 600);
    results.push({ name, kind, pass, detail: text });
    log({ event: kind, name, pass, detail: text });
    console.log(`${!pass ? "FAIL" : kind === "measure" ? "MEAS" : "PASS"}  ${name}${text ? `: ${text}` : ""}`);
  };
  const attempt = async (kind: Kind, name: string, body: () => Promise<string | void>) => {
    try {
      record(name, true, (await body()) ?? "", kind);
    } catch (error) {
      record(name, false, error instanceof Error ? `${error.name}: ${error.message}` : String(error), kind);
    }
  };

  let created = 0;
  const live = new Set<string>();
  const everCreated = new Set<string>();
  /** Set first thing on a signal or crash, so the main flow can't start another sandbox while the handler sweeps. */
  let aborting = false;
  async function withSandbox(slot: string, timeoutMs: number, body: (sandbox: Sandbox) => Promise<void>) {
    if (aborting) throw new Error("Aborting: no new sandbox");
    if (timeoutMs > LIFETIME_MS) throw new Error(`Refusing a lifetime past ${LIFETIME_MS} ms`);
    if (created >= MAX_SANDBOXES) throw new Error(`Refusing a sandbox past the limit of ${MAX_SANDBOXES}`);
    if (estimateUsd() + WORST_CASE_USD > CAP_USD) throw new Error(`Logged estimate would pass $${CAP_USD}`);
    created++;
    // Logged before the call, so an interrupted or failed create still counts and the label sweep looks for it.
    log({ event: "create-intent", slot, ttlMs: timeoutMs });
    const createdAt = Date.now();
    const sandbox = await provider.create({ timeoutMs, metadata: { ...meta, slot } }).catch((error: unknown) => {
      log({ event: "create-failed", slot, error: statusOf(error) });
      throw error;
    });
    live.add(sandbox.id);
    everCreated.add(sandbox.id);
    log({ event: "create", id: sandbox.id, slot, ttlMs: timeoutMs, createMs: Date.now() - createdAt });
    try {
      await body(sandbox);
    } finally {
      const killed = await provider.kill(sandbox.id).catch((error) => `kill failed: ${statusOf(error)}`);
      live.delete(sandbox.id);
      const activeSeconds = Math.min((Date.now() - createdAt) / 1000, LIFETIME_MS / 1000 + 60);
      // An unconfirmed kill keeps the worst case: the provider's lifetime deletes it.
      const estUsd = round(typeof killed === "boolean" ? (activeSeconds / 3600) * usdPerHour : WORST_CASE_USD);
      log({ event: "kill", id: sandbox.id, slot, createdAt: new Date(createdAt).toISOString(), killed, activeSeconds, estUsd });
    }
  }

  /** Same lock as the other claude/budget.json writers: flock on budget.json.lock. */
  function appendBudget(usd: number) {
    const entry = { at: new Date().toISOString(), run: `${vendor}-smoke ${runId}`, provider: vendor, usd, source: `${LOG} (estimate: ${rateNote})` };
    if (!existsSync(BUDGET)) return console.log(`No ${BUDGET}: record this entry by hand: ${JSON.stringify(entry)}`);
    try {
      execFileSync("flock", [`${BUDGET}.lock`, process.execPath, "-e", APPEND_BUDGET, BUDGET, JSON.stringify(entry)], { stdio: "inherit", timeout: 30_000 });
    } catch (error) {
      console.log(`Could not append to ${BUDGET} (${errorName(error)}): record this entry by hand: ${JSON.stringify(entry)}`);
    }
  }

  /** Sweep, summary and budget entry, once, on every exit path (a signal can land mid-finish); the exit code. */
  let finishing: Promise<number> | undefined;
  const finish = () => (finishing ??= wrapUp());
  async function wrapUp() {
    const leftovers = await sweep(runId, everCreated, log);
    if (leftovers !== 0) record("sweep", false, leftovers === null ? "the sweep failed: leftovers unknown" : `${leftovers} leftover(s) deleted`);
    const runUsd = round(estimateUsd(runId));
    const failed = results.filter((result) => !result.pass).map((result) => result.name);
    const checks = results.filter((result) => result.kind === "check");
    const passed = checks.filter((result) => result.pass).length;
    const measured = results.length - checks.length;
    log({ event: "summary", sandboxes: created, leftovers, passed, checks: checks.length, measured, failed, runUsd, totalUsd: round(estimateUsd()) });
    console.log(`\n${passed}/${checks.length} checks passed, ${measured} measurement(s); ${created} sandbox(es); ` +
      `leftovers ${leftovers ?? "unknown"}; this run ≈ $${runUsd}; logged total ≈ $${round(estimateUsd())}. Log: ${LOG}`);
    appendBudget(runUsd);
    return failed.length ? 1 : 0;
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, async () => {
      aborting = true;
      console.error(`${signal}: killing ${live.size} live sandbox(es), then sweeping`);
      log({ event: "interrupted", signal });
      await Promise.allSettled([...live].map((id) => provider.kill(id)));
      await finish();
      // The SDK's sockets can keep the event loop alive.
      process.exit(130);
    });
  }
  // A crash outside the main try goes through the same memoised wrap-up.
  for (const event of ["uncaughtException", "unhandledRejection"] as const) {
    process.once(event, async (error: unknown) => {
      aborting = true;
      record("crash", false, `${event}: ${statusOf(error)}`);
      await Promise.allSettled([...live].map((id) => provider.kill(id)));
      await finish();
      process.exit(1);
    });
  }

  return {
    runId, meta, log, LIFETIME_MS, record, withSandbox, finish,
    /** A verdict: it passes only when every assertion in `body` holds. */
    check: (name: string, body: () => Promise<string | void>) => attempt("check", name, body),
    /** An observation, not a verdict: it is recorded as MEAS and fails only if it could not be taken. */
    measure: (name: string, body: () => Promise<string | void>) => attempt("measure", name, body),
  };
}
