import type { Message } from "@inngest/agent-kit";
import { describe, expect, it } from "vitest";

import { withImageParts } from "./image-prompt";

const prompt: Message[] = [
  { type: "text", role: "system", content: "You are a coding agent." },
  { type: "text", role: "user", content: "Build this layout" },
];

describe("withImageParts", () => {
  it("leaves a text-only prompt unchanged", () => {
    expect(withImageParts(prompt, [])).toBe(prompt);
  });

  it("adds the images to the user message as image_url parts", () => {
    const urls = ["https://convex.test/a.png", "https://convex.test/b.png"];

    expect(withImageParts(prompt, urls)).toEqual([
      prompt[0],
      {
        type: "text",
        role: "user",
        content: [
          { type: "text", text: "Build this layout" },
          { type: "image_url", image_url: { url: urls[0] } },
          { type: "image_url", image_url: { url: urls[1] } },
        ],
      },
    ]);
  });

  it("is idempotent across the agent's iterations", () => {
    const once = withImageParts(prompt, ["https://convex.test/a.png"]);
    expect(withImageParts(once, ["https://convex.test/a.png"])).toEqual(once);
  });
});
