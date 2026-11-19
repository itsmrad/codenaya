import { Image } from "@daytona/sdk";

/** The adapter's DEFAULT_DAYTONA_SNAPSHOT; the test keeps the two equal. */
export const DEFAULT_SNAPSHOT = "codenaya-node22-v1";

/** Pinned so a rebuild under a new snapshot name changes only what we change. */
export const NODE_IMAGE = "node:22.23.5-bookworm";

/**
 * The Daytona snapshot image: Debian Node 22 (not -slim, so `localhost`
 * resolves and g++/make are there for native modules), a non-root `user` with
 * HOME=/home/user, bash as the shell, and the starters' npm cache warmed.
 * Pure, so the Dockerfile it assembles can be checked without a build.
 */
export const snapshotImage = (warmupCommands: string[]): Image =>
  Image.base(NODE_IMAGE)
    .runCommands("useradd -m -d /home/user -s /bin/bash user")
    .env({ HOME: "/home/user", SHELL: "/bin/bash" })
    // The SDK has no user() builder.
    .dockerfileCommands(["USER user"])
    .workdir("/home/user")
    .runCommands(...warmupCommands);
