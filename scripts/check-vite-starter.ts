import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { VITE_REACT_STARTER } from "../src/features/conversations/inngest/vite-starter";

// Install the emitted package.json in isolation: the host app must not mask missing deps.
const directory = mkdtempSync(join(tmpdir(), "codenaya-vite-starter-"));
const run = (command: string, args: string[], timeout = 60_000) =>
  execFileSync(command, args, { cwd: directory, stdio: "inherit", timeout });

try {
  for (const { path, content } of VITE_REACT_STARTER) {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  const started = performance.now();
  // Same five-minute ceiling as the preview's INSTALL_TIMEOUT_MS.
  run("npm", ["install", "--no-audit", "--no-fund", "--prefer-offline"], 300_000);
  const installSeconds = (performance.now() - started) / 1000;
  run(join(directory, "node_modules/.bin/tsc"), ["--noEmit", "-p", "tsconfig.app.json"]);
  run(join(directory, "node_modules/.bin/vite"), ["build"]);

  const assets = join(directory, "dist/assets");
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
    files: VITE_REACT_STARTER.length,
    dependencies: Object.keys(pkg.dependencies).length,
    devDependencies: Object.keys(pkg.devDependencies).length,
    resolvedPackages: Object.keys(lock.packages).length - 1,
    nodeModulesMiB: +(sizeKiB / 1024).toFixed(2),
    installSeconds: +installSeconds.toFixed(2),
  }, null, 2));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
