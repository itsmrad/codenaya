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
import * as nodeModule from "node:module";

import { Template, defaultBuildLogger } from "e2b";

const TEMPLATE_NAME = process.env.E2B_TEMPLATE?.trim() || "codenaya-node22";

// The starter's own imports are extensionless, as the bundler resolves them;
// plain Node needs the .ts added. Typed here: @types/node predates
// registerHooks (Node 22.15+).
type Resolve = (specifier: string, context: object) => unknown;
const { registerHooks } = nodeModule as unknown as {
  registerHooks: (hooks: {
    resolve: (specifier: string, context: object, nextResolve: Resolve) => unknown;
  }) => void;
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

// A computed specifier: Node runs the .ts file directly, and tsc doesn't
// reject the .ts extension (no allowImportingTsExtensions in tsconfig).
const starterDir = "../src/features/conversations/inngest";
const { VITE_REACT_STARTER } = await import(new URL(`${starterDir}/vite-starter.ts`, import.meta.url).href);
const { NEXT_APP_STARTER } = await import(new URL(`${starterDir}/next-starter.ts`, import.meta.url).href);
const { TANSTACK_START_STARTER } = await import(new URL(`${starterDir}/tanstack-start-starter.ts`, import.meta.url).href);
const warmup = (starter: Array<{ path: string; content: string }>) => {
  const packageJson = starter.find((file) => file.path === "package.json")!.content;
  return [
    "mkdir -p /home/user/.starter-warmup",
    `echo ${Buffer.from(packageJson).toString("base64")} | base64 -d > /home/user/.starter-warmup/package.json`,
    "cd /home/user/.starter-warmup && npm install --no-audit --no-fund",
    "rm -rf /home/user/.starter-warmup",
  ];
};

const template = Template()
  .fromNodeImage("22")
  .runCmd([...warmup(VITE_REACT_STARTER), ...warmup(NEXT_APP_STARTER), ...warmup(TANSTACK_START_STARTER)], { user: "user" });

await Template.build(template, TEMPLATE_NAME, {
  onBuildLogs: defaultBuildLogger(),
});

console.log(`Built E2B template "${TEMPLATE_NAME}". Set E2B_TEMPLATE=${TEMPLATE_NAME}.`);
