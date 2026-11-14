import { describe, expect, it } from "vitest";

import { MAX_BOOT_RESUMES, afterBootStream } from "./boot-stream-end";

describe("afterBootStream (#492)", () => {
  it("keeps the preview running when the stream ends after ready", () => {
    expect(afterBootStream({ ready: true, resumes: 0 })).toBe("done");
    expect(afterBootStream({ ready: true, resumeSandboxId: "sbx_1", resumes: 0 })).toBe("done");
  });

  it("boots again on the same sandbox when the server asks to", () => {
    expect(afterBootStream({ ready: false, resumeSandboxId: "sbx_1", resumes: 0 })).toBe(
      "resume",
    );
    expect(
      afterBootStream({ ready: false, resumeSandboxId: "sbx_1", resumes: MAX_BOOT_RESUMES - 1 }),
    ).toBe("resume");
  });

  it("gives up after MAX_BOOT_RESUMES", () => {
    expect(
      afterBootStream({ ready: false, resumeSandboxId: "sbx_1", resumes: MAX_BOOT_RESUMES }),
    ).toBe("failed");
  });

  it("leaves a stream that just ends before ready as it was", () => {
    expect(afterBootStream({ ready: false, resumes: 0 })).toBe("done");
  });
});
