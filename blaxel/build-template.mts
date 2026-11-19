/**
 * Builds the Blaxel sandbox image the cloud preview boots from (ADR 0015).
 *
 * The Blaxel counterpart of e2b/build-template.mts: Debian Node 22 (not
 * -slim, so `localhost` resolves), a non-root `user` with HOME=/home/user,
 * bash as the command shell, and the starters' npm cache warmed. Rebuild when
 * a starter's package.json changes.
 *
 * Usage (needs BL_API_KEY and BL_WORKSPACE; builds into that workspace):
 *   npm run blaxel:template
 * Uses BLAXEL_IMAGE (default: codenaya-node22) and BL_REGION (default:
 * us-was-1); set the same image name in the app.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ImageInstance, SandboxInstance } from "@blaxel/core";

// Computed, like the starter imports in e2b/starters.mts: Node runs the .mts
// directly, and tsc doesn't reject the extension.
const { STARTER_WARMUP_COMMANDS }: { STARTER_WARMUP_COMMANDS: string[] } = await import(
  new URL("../e2b/starters.mts", import.meta.url).href
);

const IMAGE_NAME = process.env.BLAXEL_IMAGE?.trim() || "codenaya-node22";
// Region the image is built in. Non-root sandboxes ship by default only in
// us-pdx-1 and us-was-1. The SDK sends no region for the build sandbox
// itself, so the platform picks where that one deploys.
const REGION = process.env.BL_REGION?.trim() || "us-was-1";

// The builder slims images by default, which deletes compilers (gcc, g++,
// make) that native npm modules need. The SDK has no option for it, so a
// blaxel.toml in the build context turns it off, as `bl deploy` reads it.
const contextDir = mkdtempSync(join(tmpdir(), "codenaya-blaxel-"));
const buildToml = join(contextDir, "blaxel.toml");
writeFileSync(buildToml, "[build]\nslim = false\n");

const image = ImageInstance.fromRegistry("node:22-bookworm")
  .addLocalFile(buildToml, "/tmp/blaxel.toml", "blaxel.toml")
  .runCommands("rm -f /tmp/blaxel.toml", "useradd -m -d /home/user -s /bin/bash user")
  .env({ HOME: "/home/user", SHELL: "/bin/bash", BL_SANDBOX_USER_ENABLED: "true" })
  .user("user")
  .workdir("/home/user")
  .runCommands(...STARTER_WARMUP_COMMANDS);

const startedAt = Date.now();
try {
  // Builds by deploying a sandbox named after the image.
  const sandbox = await image.build({
    name: IMAGE_NAME,
    buildMemory: 8192,
    buildRegion: REGION,
    timeout: 20 * 60_000,
    onStatusChange: (status) => console.log(`[${Math.round((Date.now() - startedAt) / 1000)}s] ${status}`),
  });
  console.log(`Built in ${Math.round((Date.now() - startedAt) / 1000)}s; image: ${sandbox.spec?.runtime?.image ?? "(not reported)"}`);
} finally {
  rmSync(contextDir, { recursive: true, force: true });
  // The build sandbox is not needed after the build; deleting it keeps the image.
  // The build overwrites, and this deletes, any sandbox already named IMAGE_NAME.
  await SandboxInstance.delete(IMAGE_NAME).then(
    () => console.log(`Deleted build sandbox "${IMAGE_NAME}".`),
    (error: unknown) => console.warn(`Could not delete build sandbox "${IMAGE_NAME}":`, error),
  );
}

console.log(`Built Blaxel image "${IMAGE_NAME}". Set BLAXEL_IMAGE=${IMAGE_NAME}.`);
