import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

import { KNOWN_GOOD_VERSIONS } from "../src/features/conversations/inngest/known-good-versions.ts";

// fromNodeImage("22") in e2b/build-template.mts pins no minor. Vite 8 needs
// 22.12+, and the sandbox refuses an older Node before installing (node-compat.ts).
// This does not certify the deployed template or WebContainer.
const NODE_FLOOR = "22.12.0";

export function checkKnownGoodVersions(view = (spec) => JSON.parse(execFileSync(
  "npm", ["view", spec, "version", "peerDependencies", "engines", "--json"],
  { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] },
)), budgetMs = 300_000) {
  // One budget for the whole run, so a registry outage fails (and files the issue) before the job timeout.
  const deadline = Date.now() + budgetMs;
  const failures = [];
  let checked = 0;
  for (const [name, range] of Object.entries(KNOWN_GOOD_VERSIONS)) {
    const spec = `${name}@${range}`;
    if (Date.now() >= deadline) {
      failures.push(`${spec}: skipped, time budget spent`);
      continue;
    }
    try {
      const result = view(spec);
      // npm omits absent fields and emits bare version strings for metadata-free packages.
      const versions = (Array.isArray(result) ? result : [result]).map((entry) =>
        typeof entry === "string" ? { version: entry } : entry);
      if (!versions.length || versions.some((entry) =>
        !entry?.version || !semver.satisfies(entry.version, range))) {
        failures.push(`${spec}: unresolved range or invalid registry response`);
        continue;
      }
      checked++;
      // A fresh install picks the highest matching version, not historical releases.
      const latest = versions.sort((a, b) => semver.rcompare(a.version, b.version))[0];
      const react = latest.peerDependencies?.react;
      const node = latest.engines?.node;
      if ((react && !semver.intersects(react, KNOWN_GOOD_VERSIONS.react)) ||
          (node && !semver.satisfies(NODE_FLOOR, node))) {
        failures.push(`${spec} (${latest.version}): incompatible requirements ${JSON.stringify({ react, node })}`);
      }
    } catch {
      failures.push(`${spec}: npm view failed (unresolved range, registry error, or invalid metadata)`);
    }
  }
  const summary = `Manifest registry check: ${checked}/${Object.keys(KNOWN_GOOD_VERSIONS).length} ranges resolved; ${failures.length} failures (React ${KNOWN_GOOD_VERSIONS.react}, Node floor ${NODE_FLOOR}).`;
  return { failures, summary };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { failures, summary } = checkKnownGoodVersions();
  console.log([summary, ...failures].join("\n"));
  process.exitCode = failures.length ? 1 : 0;
}
