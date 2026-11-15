import { describe, expect, it } from "vitest";

import { createWithPromptBody } from "./use-create-project-from-prompt";

const model = { modelId: "x-ai/grok-4.7" };

describe("createWithPromptBody", () => {
  it("sends the picked mode", () => {
    expect(createWithPromptBody("A kanban board", model, undefined, false, "swarm")).toMatchObject({
      prompt: "A kanban board",
      model,
      mode: "swarm",
    });
    expect(createWithPromptBody("A blog", model, undefined, true, "plan")).toMatchObject({ mode: "plan", fromLanding: true });
  });

  it("omits the mode for build, as the chat composer does", () => {
    expect(createWithPromptBody("A blog", model, undefined, false, "build")).not.toHaveProperty("mode");
    expect(createWithPromptBody("A blog", model)).not.toHaveProperty("mode");
  });
});
