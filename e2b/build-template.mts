/**
 * Builds the E2B template the cloud preview boots from (#178).
 *
 * The E2B `base` image ships Node 20.9, and Vite 7 needs ^20.19 || >=22.12
 * (it calls `crypto.hash`), so generated apps on Vite 7 crash at startup.
 * This template is the official Node 22 LTS image, which E2B turns into a
 * sandbox with the same `user` account and /home/user home the route expects.
 *
 * It also installs both starters' dependencies (Vite and Next.js) once and
 * keeps only the npm cache (~/.npm), so a preview's `npm install
 * --prefer-offline` mostly resolves from disk (#338). Rebuild when either
 * starter's package.json changes.
 *
 * Usage (needs E2B_API_KEY; builds into that key's E2B team):
 *   npm run e2b:template
 * Uses E2B_TEMPLATE (default: codenaya-node22); set the same value in the app.
 */
import { Template, defaultBuildLogger } from "e2b";

// Computed, like the starter imports in starters.mts: Node runs the .mts
// directly, and tsc doesn't reject the extension.
const { STARTER_WARMUP_COMMANDS }: { STARTER_WARMUP_COMMANDS: string[] } = await import(
  new URL("./starters.mts", import.meta.url).href
);

const TEMPLATE_NAME = process.env.E2B_TEMPLATE?.trim() || "codenaya-node22";

const template = Template()
  .fromNodeImage("22")
  .runCmd(STARTER_WARMUP_COMMANDS, { user: "user" });

await Template.build(template, TEMPLATE_NAME, {
  memoryMB: Number(process.env.E2B_TEMPLATE_MEMORY_MB || 2048),
  cpuCount: Number(process.env.E2B_TEMPLATE_CPU || 2),
  onBuildLogs: defaultBuildLogger(),
});

console.log(`Built E2B template "${TEMPLATE_NAME}". Set E2B_TEMPLATE=${TEMPLATE_NAME}.`);
