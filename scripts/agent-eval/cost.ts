import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Usage } from "./types";

const exec = promisify(execFile);
export const LEDGER = "scripts/agent-eval/results/ledger.json";

export function tokenCost(model: string, input: number, output: number, cacheRead = 0, cacheWrite = 0) {
  const rate = model === "claude-haiku-5-5" ? (input > 100_000 ? [0.5, 2.5, 0.05] : [0.1, 0.5, 0.01])
    : model === "claude-sonnet-5-5" ? [2, 10, 0.1]
    : model === "claude-opus-5-5" ? [4, 20, 0.2] : null;
  if (!rate) throw new Error(`No verified prices for ${model}`);
  if ([input, output, cacheRead, cacheWrite].some((n) => !Number.isFinite(n) || n < 0)) throw new Error("Invalid token usage");
  return (input * rate[0] + output * rate[1] + cacheRead * rate[2] + cacheWrite * rate[0] * 1.25) / 1_000_000;
}

/** Read-only CLI: never emit its raw output (it includes other users' rows). */
export async function readUsage(): Promise<Usage[]> {
  try {
    const { stdout } = await exec(process.execPath, ["node_modules/convex/bin/main.js", "data", "creditLedger", "--limit", "200", "--format", "json"], { timeout: 20_000, maxBuffer: 4_000_000 });
    const rows: Usage[] = JSON.parse(stdout);
    if (!Array.isArray(rows)) throw new Error("Not an array");
    return rows;
  } catch {
    throw new Error("creditLedger CLI unavailable: live metering is required; ask EVAL for access");
  }
}

type Entry = { at: string; run: string; provider: string; model: string; tokens_in: number; tokens_out: number; usd: number };
export async function ledgerEntries(): Promise<Entry[]> {
  try { return JSON.parse(await readFile(LEDGER, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

/** Upsert by `run`, so repeated polls of one message never double count. */
export async function appendLedger(...updates: Entry[]) {
  const entries = await ledgerEntries();
  for (const entry of updates) {
    const index = entries.findIndex((e) => e.run === entry.run);
    if (index < 0) entries.push(entry); else entries[index] = entry;
  }
  await mkdir("scripts/agent-eval/results", { recursive: true });
  await writeFile(LEDGER, JSON.stringify(entries, null, 2));
}

export const recordUsage = (run: string, rows: Usage[]) =>
  appendLedger(...rows.map((row) => ({ at: new Date().toISOString(), run: `${run}/${row.messageId}`, provider: "anthropic", model: row.model, tokens_in: row.inputTokens, tokens_out: row.outputTokens, usd: row.costUsd })));

export const totalUsd = (rows: Usage[]) => rows.reduce((sum, r) => sum + r.costUsd, 0);
