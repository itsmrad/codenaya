import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

import { VITE_REACT_STARTER } from "../src/features/conversations/inngest/vite-starter";
import { NEXT_APP_STARTER } from "../src/features/conversations/inngest/next-starter";
import { TANSTACK_START_STARTER } from "../src/features/conversations/inngest/tanstack-start-starter";
import { WEBCONTAINER_VITE_PINS } from "../src/features/webcontainer-preview/utils/vite-pin";

type Pin = { name: string; version: string; users: string[] };

/** Every dependency the starters (and the WebContainer Vite fallback) pin, deduplicated by name@version. */
export function starterPins(): Pin[] {
  const pins = new Map<string, Pin>();
  const add = (user: string, deps: Record<string, string> = {}) => {
    for (const [name, version] of Object.entries(deps)) {
      const pin = pins.get(`${name}@${version}`) ?? { name, version, users: [] };
      pin.users.push(user);
      pins.set(`${name}@${version}`, pin);
    }
  };
  for (const [kind, files] of Object.entries({ vite: VITE_REACT_STARTER, next: NEXT_APP_STARTER, start: TANSTACK_START_STARTER })) {
    const pkg = JSON.parse(files.find(({ path }) => path === "package.json")!.content);
    add(kind, pkg.dependencies);
    add(kind, pkg.devDependencies);
  }
  add("webcontainer", WEBCONTAINER_VITE_PINS);
  return [...pins.values()];
}

// --prefer-online: a stale cached packument is how an unpublished version slipped through (ETARGET).
const npmVersions = (name: string): string | string[] => JSON.parse(execFileSync(
  "npm", ["view", name, "versions", "--json", "--prefer-online"],
  { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] },
));

/** Fails on non-exact or unpublished pins; newer stable releases are info only. */
export function checkStarterManifest(view = npmVersions, pins = starterPins()) {
  const failures: string[] = [];
  const info: string[] = [];
  for (const { name, version, users } of pins) {
    const label = `${name}@${version} (${users.join(", ")})`;
    if (semver.valid(version) !== version) {
      failures.push(`${label}: not an exact version`);
      continue;
    }
    let versions: string[];
    try {
      versions = [view(name)].flat();
    } catch {
      failures.push(`${label}: npm view failed`);
      continue;
    }
    if (!versions.includes(version)) {
      failures.push(`${label}: not published on the registry`);
      continue;
    }
    const newest = versions.filter((v) => semver.valid(v) && !semver.prerelease(v)).sort(semver.rcompare)[0];
    if (newest && semver.gt(newest, version)) info.push(`info: ${label}: newer stable ${newest}`);
  }
  const summary = `Starter manifest check: ${pins.length} exact pins; ${failures.length} failures, ${info.length} newer stable (info only).`;
  return { failures, info, summary };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { failures, info, summary } = checkStarterManifest();
  console.log([summary, ...failures, ...info].join("\n"));
  process.exitCode = failures.length ? 1 : 0;
}
