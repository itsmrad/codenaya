/**
 * Builds the E2B template the cloud preview boots from (#178).
 *
 * The E2B `base` image ships Node 20.9, and Vite 7 needs ^20.19 || >=22.12
 * (it calls `crypto.hash`), so generated apps on Vite 7 crash at startup.
 * This template is the official Node 22 LTS image, which E2B turns into a
 * sandbox with the same `user` account and /home/user home the route expects.
 *
 * It also installs the Vite starter's dependencies once and keeps only the
 * npm cache (~/.npm), so a preview's `npm install --prefer-offline` mostly
 * resolves from disk (#338). Rebuild when the starter's package.json changes.
 *
 * Usage (needs E2B_API_KEY; builds into that key's E2B team):
 *   npm run e2b:template
 * then set E2B_TEMPLATE=codenaya-node22 wherever the app runs.
 */
import { Template, defaultBuildLogger } from "e2b";

const TEMPLATE_NAME = "codenaya-node22";

// A computed specifier: Node runs the .ts file directly, and tsc doesn't
// reject the .ts extension (no allowImportingTsExtensions in tsconfig).
const starterModule = new URL("../src/features/conversations/inngest/vite-starter.ts", import.meta.url);
const { VITE_REACT_STARTER } = await import(starterModule.href);
const starterPackageJson: string = VITE_REACT_STARTER.find(
  (file: { path: string }) => file.path === "package.json",
).content;

const template = Template()
  .fromNodeImage("22")
  .runCmd(
    [
      "mkdir -p /home/user/.starter-warmup",
      `echo ${Buffer.from(starterPackageJson).toString("base64")} | base64 -d > /home/user/.starter-warmup/package.json`,
      "cd /home/user/.starter-warmup && npm install --no-audit --no-fund",
      "rm -rf /home/user/.starter-warmup",
    ],
    { user: "user" },
  );

await Template.build(template, TEMPLATE_NAME, {
  onBuildLogs: defaultBuildLogger(),
});

console.log(`Built E2B template "${TEMPLATE_NAME}". Set E2B_TEMPLATE=${TEMPLATE_NAME}.`);
