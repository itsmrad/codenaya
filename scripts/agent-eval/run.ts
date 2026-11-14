import { parseArgs } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { userConvexClient } from "../../e2e/convex-client";
import { session } from "./session";
import { drive, finalFiles } from "./drive";
import { ledgerEntries, readUsage } from "./cost";
import { sanitize } from "./capture";
import { score } from "./score";
import { judge } from "./judge";
import type { Score } from "./score";

async function main() {
  const { values } = parseArgs({ options: { models: { type: "string", default: "claude-haiku-5-5" }, prompts: { type: "string", default: "booking,saas,crm" }, runs: { type: "string", default: "1" }, "max-usd": { type: "string" }, "budget-usd": { type: "string", default: "2" }, "base-url": { type: "string", default: "http://localhost:3213" }, judge: { type: "boolean", default: false }, "judge-model": { type: "string", default: "claude-haiku-5-5" }, keep: { type: "boolean", default: false } } });
  if (process.env.CI) throw new Error("Live agent evaluation never runs in CI");
  for (const name of ["NEXT_PUBLIC_CONVEX_URL", "CODENAYA_CONVEX_INTERNAL_KEY", "CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "E2B_API_KEY"]) {
    if (!process.env[name]) throw new Error(`Missing ${name}: run with Infisical dev`);
  }
  const prompts: Record<string, { prompt: string; rubric: string[] }> = JSON.parse(await readFile("scripts/agent-eval/prompts.json", "utf8"));
  const models = values.models!.split(",");
  const names = values.prompts!.split(",");
  const count = Number(values.runs);
  const budget = Number(values["budget-usd"]);
  if (!Number.isInteger(count) || count < 1 || !Number.isFinite(budget) || budget <= 0) throw new Error("--runs must be positive integer; --budget-usd positive finite");
  if (names.some((n) => !prompts[n]) || (names.includes("followup") && !names.includes("saas"))) throw new Error("Unknown prompt, or followup without saas");
  if (models.some((m) => !["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"].includes(m))) throw new Error("No verified metering prices for requested model");
  if (values["max-usd"] && (!Number.isFinite(Number(values["max-usd"])) || Number(values["max-usd"]) <= 0)) throw new Error("--max-usd must be positive finite");
  await readUsage();
  const directory = `scripts/agent-eval/results/${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await mkdir(directory, { recursive: true });
  const scores: Judged[] = [];
  const { browser, page: auth, user } = await session(values["base-url"]!);
  try {
    for (const model of models) for (let run = 1; run <= count; run++) {
      let saasId: Id<"projects"> | undefined;
      for (const name of names.filter((n) => n !== "followup").flatMap((n) => n === "saas" && names.includes("followup") ? [n, "followup"] : [n])) {
        const remaining = budget - (await ledgerEntries()).reduce((sum, e) => sum + e.usd, 0);
        if (remaining <= 0) throw new Error("Local ledger allowance exhausted; ask EVAL before raising --budget-usd");
        const id = `${model}-${name}-${run}`;
        const runDirectory = `${directory}/runs/${id}`;
        const page = await auth.context().newPage();
        let projectId: Id<"projects"> | undefined;
        try {
          const cap = Math.min(remaining, Number(values["max-usd"] ?? (model.includes("haiku") ? 0.75 : model.includes("sonnet") ? 2 : 3)));
          if (name === "followup" && !saasId) throw new Error("Cannot follow up: saas did not create a project");
          const trail = await drive(page, user, { id: `${directory}/${id}`, model, prompt: prompts[name].prompt, maxUsd: cap, directory: runDirectory, projectId: name === "followup" ? saasId : undefined });
          projectId = trail.projectId as Id<"projects"> | undefined;
          const result: Judged = score(trail, projectId ? await finalFiles(projectId) : []);
          result.id = id;
          if (values.judge && trail.preview.screenshot) result.judge = await judge(trail.id, values["judge-model"]!, prompts[name].prompt, prompts[name].rubric, `${runDirectory}/${trail.preview.screenshot}`);
          scores.push(result);
          await writeFile(`${runDirectory}/score.json`, sanitize(result));
          await writeFile(`${directory}/scoreboard.md`, scoreboard(scores, values["base-url"]!));
          console.log(`${id}: completed=${result.completed}, preview=${result.preview.loaded}, tokens=${result.tokensIn}/${result.tokensOut}, $${result.usd.toFixed(6)}; ${runDirectory}`);
          if (name === "saas") saasId = projectId;
        } finally {
          await page.close();
          if (projectId && !values.keep && !(name === "saas" && names.includes("followup"))) await (await userConvexClient(auth)).mutation(api.projects.remove, { id: projectId });
        }
      }
    }
  } finally { await browser.close(); }
}

type Judged = Score & { judge?: Awaited<ReturnType<typeof judge>> };

function scoreboard(scores: Judged[], base: string) {
  return `# Agent evaluation\n\n| Model / prompt | Completed | Build passes | Tool errors | Calls ≈ / cap | Preview | Fixes | First preview / wall (s) | Tokens in/out | USD | Judge | Project |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n` + scores.map((s) => `| ${s.id} | ${s.completed} | ${s.checkBuild.filter((c) => c.passed).length}/${s.checkBuild.length} | ${s.toolErrorCount} | ${s.modelCallsApprox}/${s.iterationCapHit || s.capped} | ${s.preview.loaded && !s.preview.overlay} | ${s.autoFixCount} | ${s.firstPreviewMs === null ? "—" : (s.firstPreviewMs / 1000).toFixed(1)} / ${(s.wallMs / 1000).toFixed(1)} | ${s.tokensIn}/${s.tokensOut} | ${s.usd.toFixed(6)} | ${s.judge ? `${s.judge.score}/10, ${s.judge.passed}/${s.judge.total}` : "—"} | [open](${base}/projects/${s.projectId}) |`).join("\n") + "\n";
}

main().catch((error) => { console.error(JSON.parse(sanitize({ error: String(error) })).error); process.exitCode = 1; });
