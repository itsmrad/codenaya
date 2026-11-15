import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { VITE_REACT_STARTER } from "../src/features/conversations/inngest/vite-starter";
import { NEXT_APP_STARTER } from "../src/features/conversations/inngest/next-starter";

assert.ok(process.argv[2] === undefined || process.argv[2] === "next", "Usage: npm run check:starter [-- next]");
const next = process.argv[2] === "next";
const starter = next ? NEXT_APP_STARTER : VITE_REACT_STARTER;

// Install the emitted package.json in isolation: the host app must not mask missing deps.
const directory = mkdtempSync(join(tmpdir(), next ? "codenaya-next-starter-" : "codenaya-vite-starter-"));
const run = (command: string, args: string[], timeout = 60_000) =>
  execFileSync(command, args, {
    cwd: directory, stdio: "inherit", timeout,
    env: next ? { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } : process.env,
  });

try {
  for (const { path, content } of starter) {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  const started = performance.now();
  // Same five-minute ceiling as the preview's INSTALL_TIMEOUT_MS.
  run("npm", ["install", "--no-audit", "--no-fund", "--prefer-offline"], 300_000);
  const installSeconds = (performance.now() - started) / 1000;
  if (next) {
    run(join(directory, "node_modules/.bin/next"), ["build"], 300_000);
  } else {
    run(join(directory, "node_modules/.bin/tsc"), ["--noEmit", "-p", "tsconfig.app.json"]);
    run(join(directory, "node_modules/.bin/vite"), ["build"]);
  }

  // Turbopack (Next 16) writes CSS chunks next to the JS ones.
  const assets = join(directory, next ? ".next/static/chunks" : "dist/assets");
  const css = readdirSync(assets).filter((name) => name.endsWith(".css"))
    .map((name) => readFileSync(join(assets, name), "utf8")).join("\n");
  // These utilities cover the primitives' semantic colors, v4 opacity and animations.
  for (const selector of [".bg-primary", ".bg-popover", ".text-muted-foreground", ".border-input", ".shadow-xs"]) {
    assert.ok(css.includes(selector), `Missing compiled starter utility: ${selector}`);
  }
  assert.ok(css.includes("animate-in"), "Missing compiled overlay animations");
  assert.ok(css.includes("var(--popover)"), "Popover utility must use the starter theme");
  const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(directory, "package-lock.json"), "utf8"));
  const sizeKiB = Number(execFileSync("du", ["-sk", join(directory, "node_modules")], { encoding: "utf8" }).split(/\s/)[0]);
  console.log(JSON.stringify({
    files: starter.length,
    dependencies: Object.keys(pkg.dependencies).length,
    devDependencies: Object.keys(pkg.devDependencies).length,
    resolvedPackages: Object.keys(lock.packages).length - 1,
    nodeModulesMiB: +(sizeKiB / 1024).toFixed(2),
    installSeconds: +installSeconds.toFixed(2),
  }, null, 2));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
