import { describe, expect, it } from "vitest";

import { LOST_RUN_MESSAGE } from "../../agent-steps";
import { keyFailureMessage } from "@/features/ai-providers/server/resolve-run-model";
import { AGENT_FAILURE_MESSAGE, DEFAULT_REPLY_MESSAGE, UNFINISHED_REPLY, priorTurns } from "./conversation-history";

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

const unfinished = (content: string) => [
  { type: "text", role: "user", content },
  { type: "text", role: "assistant", content: UNFINISHED_REPLY },
];

describe("priorTurns", () => {
  it.each([
    AI_NOT_CONFIGURED_MESSAGE,
    ...Object.values(PROMO_REFUSAL_MESSAGES),
    DISPATCH_FAILED_MESSAGE,
  ])("keeps the request but not the failure text for %s", (content) => {
    expect(priorTurns([user("Try"), reply(content), user("Again")], "current")).toEqual([
      { type: "text", role: "user", content: "Try" },
      { type: "text", role: "assistant", content: UNFINISHED_REPLY },
    ]);
  });

  it("keeps the request and default reply when a successful run had no summary", () => {
    expect(priorTurns([user("Build a todo app"), reply(DEFAULT_REPLY_MESSAGE), user("Next")], "current")).toEqual([
      { type: "text", role: "user", content: "Build a todo app" },
      { type: "text", role: "assistant", content: DEFAULT_REPLY_MESSAGE },
    ]);
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

  it("keeps the requests of cancelled, failed, running and empty turns, without their replies", () => {
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
      ...["Stopped", "Crashed", "Lost", "Bad key", "Still running"].flatMap(unfinished),
      { type: "text", role: "user", content: "Kept" },
      { type: "text", role: "assistant", content: "Done." },
    ]);
  });

  it("keeps the original request when a stopped first run is followed by continue", () => {
    const current = reply("", "processing");
    const messages = [user("Build a pizzeria site"), reply("", "cancelled"), user("continue"), current];

    expect(priorTurns(messages, current._id)).toEqual(unfinished("Build a pizzeria site"));
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
