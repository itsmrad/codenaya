/**
 * Starter loading and npm-cache warmup shared by the sandbox image builds
 * (e2b/build-template.mts, blaxel/build-template.mts).
 */
import * as nodeModule from "node:module";

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

/**
 * Installs every starter's dependencies once and keeps only the npm cache
 * (~/.npm), so a preview's `npm install --prefer-offline` mostly resolves
 * from disk (#338). Run as `user` with HOME=/home/user.
 */
export const STARTER_WARMUP_COMMANDS: string[] = [
  ...warmup(VITE_REACT_STARTER),
  ...warmup(NEXT_APP_STARTER),
  ...warmup(TANSTACK_START_STARTER),
];
