import { describe, expect, it } from "vitest";

import { DEFAULT_DAYTONA_SNAPSHOT } from "../src/features/sandbox-preview/server/provider/daytona";

import { DEFAULT_SNAPSHOT, NODE_IMAGE, snapshotImage } from "./snapshot-image";

describe("snapshotImage", () => {
  it("creates the user before switching to it, then warms the cache as that user", () => {
    const lines = snapshotImage(["echo one", "cd /x && npm install"])
      .dockerfile.split("\n")
      .filter(Boolean);

    expect(lines).toEqual([
      `FROM ${NODE_IMAGE}`,
      "RUN useradd -m -d /home/user -s /bin/bash user",
      "ENV HOME=/home/user",
      "ENV SHELL=/bin/bash",
      "USER user",
      "WORKDIR /home/user",
      "RUN echo one",
      "RUN cd /x && npm install",
    ]);
    expect(NODE_IMAGE).toMatch(/^node:22\.\d+\.\d+-bookworm$/);
  });

  it("builds the snapshot the app boots by default", () => {
    expect(DEFAULT_SNAPSHOT).toBe(DEFAULT_DAYTONA_SNAPSHOT);
  });
});
