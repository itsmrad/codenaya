import { describe, expect, it } from "vitest";

import { userMessageBlocks } from "./user-message";

describe("userMessageBlocks", () => {
  it("keeps plain prose as one text block", () => {
    expect(userMessageBlocks("Make the header sticky.\n\nAnd blue.")).toEqual([
      { kind: "text", text: "Make the header sticky.\n\nAnd blue." },
    ]);
  });

  it("splits a pasted Vite error into prose and a code block", () => {
    const frame = [
      "/home/user/app/src/main.tsx:3:17",
      '1  |  import React from "react";',
      '3  |  import Home from "@/pages/index";',
      "   |                    ^",
    ].join("\n");
    expect(userMessageBlocks(`The preview broke:\n\n${frame}\n\nCan you fix it?`)).toEqual([
      { kind: "text", text: "The preview broke:" },
      { kind: "code", text: frame },
      { kind: "text", text: "Can you fix it?" },
    ]);
  });

  it("treats stack traces as code", () => {
    const trace = "Error: boom\n    at a (file.js:1:1)\n    at b (file.js:2:2)";
    expect(userMessageBlocks(trace)).toEqual([{ kind: "code", text: trace }]);
  });

  it("unwraps fenced blocks", () => {
    expect(userMessageBlocks("Use this:\n```ts\nconst a = 1;\n```\nThanks")).toEqual([
      { kind: "text", text: "Use this:" },
      { kind: "code", text: "const a = 1;" },
      { kind: "text", text: "Thanks" },
    ]);
  });

  it("leaves short or mostly prose paragraphs alone", () => {
    const text = "First line\nconst x = 1;\nthird line\nfourth line";
    expect(userMessageBlocks(text)).toEqual([{ kind: "text", text }]);
  });
});
