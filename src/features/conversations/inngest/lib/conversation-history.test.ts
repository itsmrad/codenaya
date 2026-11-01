import { describe, expect, it } from "vitest";

import { LOST_RUN_MESSAGE } from "../../agent-steps";
import { keyFailureMessage } from "@/features/ai-providers/server/resolve-run-model";
import { AGENT_FAILURE_MESSAGE, DEFAULT_REPLY_MESSAGE, priorTurns } from "./conversation-history";

import { AI_NOT_CONFIGURED_MESSAGE } from "@/features/ai-providers/server/platform-model";
import { PROMO_REFUSAL_MESSAGES } from "@/features/promotions/github-promo";
import { DISPATCH_FAILED_MESSAGE } from "@/lib/message-processor";

type Status = "processing" | "completed" | "cancelled";

let next = 0;
const user = (content: string) => ({ _id: `u${next++}`, role: "user" as const, content });
const reply = (content: string, status: Status = "completed") => ({
  _id: `a${next++}`,
  role: "assistant" as const,
  content,
  status,
});

describe("priorTurns", () => {
  it.each([
    AI_NOT_CONFIGURED_MESSAGE,
    ...Object.values(PROMO_REFUSAL_MESSAGES),
    DISPATCH_FAILED_MESSAGE,
    DEFAULT_REPLY_MESSAGE,
  ])("omits the entire failed turn for %s", (content) => {
    expect(priorTurns([user("Try"), reply(content)], "current")).toEqual([]);
  });

  it("returns earlier turns in order, without the request this run answers", () => {
    const current = reply("", "processing");
    const messages = [
      user("Build a todo app"),
      reply("Built a todo app."),
      user("Add filters"),
      reply("Added filters."),
      user("Now make it dark"),
      current,
    ];

    expect(priorTurns(messages, current._id)).toEqual([
      { type: "text", role: "user", content: "Build a todo app" },
      { type: "text", role: "assistant", content: "Built a todo app." },
      { type: "text", role: "user", content: "Add filters" },
      { type: "text", role: "assistant", content: "Added filters." },
    ]);
  });

  it("leaves out cancelled, failed, running and empty turns whole", () => {
    const current = reply("", "processing");
    const messages = [
      user("Stopped"),
      reply("Half a reply", "cancelled"),
      user("Crashed"),
      reply(AGENT_FAILURE_MESSAGE),
      user("Lost"),
      reply(LOST_RUN_MESSAGE),
      user("Bad key"),
      reply(keyFailureMessage("Your Stub key was rejected by the provider.")),
      user("Still running"),
      reply("", "processing"),
      user("Kept"),
      reply("Done."),
      user("Now"),
      current,
    ];

    expect(priorTurns(messages, current._id)).toEqual([
      { type: "text", role: "user", content: "Kept" },
      { type: "text", role: "assistant", content: "Done." },
    ]);
  });

  it("drops a reply whose request fell outside the window, and keeps image-only requests", () => {
    const current = reply("", "processing");
    const messages = [reply("Orphan"), user(""), reply("Described the image."), user("Next"), current];

    expect(priorTurns(messages, current._id)).toEqual([
      { type: "text", role: "user", content: "(images only)" },
      { type: "text", role: "assistant", content: "Described the image." },
    ]);
  });
});
