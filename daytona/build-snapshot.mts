/**
 * Builds the Daytona snapshot the cloud preview boots from (ADR 0015).
 *
 * The Daytona counterpart of e2b/build-template.mts; the image itself is
 * daytona/snapshot-image.ts.
 * Snapshots can't be rebuilt in place, and sandboxes may be booting from the
 * current one, so this refuses an existing name: when a starter's
 * package.json changes, build under a new name (bump the -vN suffix) and point
 * DAYTONA_SNAPSHOT at it.
 *
 * Usage (needs DAYTONA_API_KEY; builds into that key's organization):
 *   npm run daytona:snapshot
 * Uses DAYTONA_SNAPSHOT (default: codenaya-node22-v1, the app's default),
 * DAYTONA_API_URL (default: https://app.daytona.io/api) and DAYTONA_TARGET
 * (region; default: the organization's). Use the app's DAYTONA_TARGET, so the
 * snapshot lands in the region its sandboxes boot in.
 */
import { Daytona, DaytonaNotFoundError } from "@daytona/sdk";

// Computed, like the starter imports in e2b/starters.mts: Node runs the .ts
// directly, and tsc doesn't reject the extension.
const { STARTER_WARMUP_COMMANDS }: { STARTER_WARMUP_COMMANDS: string[] } = await import(
  new URL("../e2b/starters.mts", import.meta.url).href
);
const { DEFAULT_SNAPSHOT, snapshotImage }: typeof import("./snapshot-image") = await import(
  new URL("./snapshot-image.ts", import.meta.url).href
);

const SNAPSHOT_NAME = process.env.DAYTONA_SNAPSHOT?.trim() || DEFAULT_SNAPSHOT;
const apiKey = process.env.DAYTONA_API_KEY?.trim();
if (!apiKey) throw new Error("DAYTONA_API_KEY is not set");

// Built like the adapter's client. The endpoint is always passed, so the SDK's dotenv-ambiguity check can't throw.
const daytona = new Daytona({
  apiKey,
  apiUrl: process.env.DAYTONA_API_URL?.trim() || "https://app.daytona.io/api",
  target: process.env.DAYTONA_TARGET?.trim() || undefined,
});

const existing = await daytona.snapshot.get(SNAPSHOT_NAME).catch((error: unknown) => {
  if (error instanceof DaytonaNotFoundError) return undefined;
  throw error;
});
if (existing) {
  const failed = existing.state === "error" || existing.state === "build_failed";
  throw new Error(
    `Daytona snapshot "${SNAPSHOT_NAME}" already exists (${existing.state}). ` +
      (failed
        ? "Delete it (dashboard or daytona.snapshot.delete) to retry this name; "
        : "Set DAYTONA_SNAPSHOT to a new name to build another; ") +
      "this script never overwrites one.",
  );
}

// 20 min, like blaxel:template. The SDK's own timeout covers only the create
// request, not the build it then polls, so a timer bounds the whole build.
const buildDeadline = setTimeout(() => {
  console.error(`Build of "${SNAPSHOT_NAME}" did not finish in 20 min; check its state in the Daytona dashboard.`);
  process.exit(1);
}, 20 * 60_000);
const startedAt = Date.now();
const snapshot = await daytona.snapshot.create(
  {
    name: SNAPSHOT_NAME,
    image: snapshotImage(STARTER_WARMUP_COMMANDS),
    // Disk in GiB; these are the defaults each sandbox from the snapshot gets.
    resources: { cpu: 2, memory: 2, disk: 5 },
  },
  { onLogs: (chunk) => console.log(chunk) },
);
clearTimeout(buildDeadline);

console.log(
  `Built Daytona snapshot "${snapshot.name}" (${snapshot.state}) in ${Math.round((Date.now() - startedAt) / 1000)}s. ` +
    `Set DAYTONA_SNAPSHOT=${snapshot.name}.`,
);
