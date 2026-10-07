import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));

import {
  SKILL_IMPORT_RATE_LIMIT,
  resetRateLimits,
} from "@/features/integrations/server/rate-limit";

import { POST } from "./route";

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/skills/import", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );

const SKILL_MD = `---
name: react-best-practices
description: >
  React performance rules.
  Use when writing components.
---
# React

Memoize wisely.
`;

describe("POST /api/skills/import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimits();
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.auth.mockResolvedValue({ userId: "user_1" });
    mocks.fetch.mockImplementation(async () => new Response(SKILL_MD));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 401 when signed out", async () => {
    mocks.auth.mockResolvedValue({ userId: null });

    const res = await post({ url: "o/r/x" });

    expect(res.status).toBe(401);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("previews a skill without storing it", async () => {
    const res = await post({
      url: "https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      skill: {
        name: "react-best-practices",
        description: "React performance rules. Use when writing components.",
        body: "# React\n\nMemoize wisely.",
        sourceUrl:
          "https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices",
      },
    });
    expect(mocks.fetch).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/vercel-labs/agent-skills/main/skills/react-best-practices/SKILL.md",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("falls back to the folder name for a skills.sh page", async () => {
    mocks.fetch
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response("---\ndescription: Finds skills.\n---\nBody"));

    const res = await post({ url: "https://skills.sh/vercel-labs/skills/find-skills" });

    expect(await res.json()).toMatchObject({
      skill: {
        name: "find-skills",
        sourceUrl: "https://github.com/vercel-labs/skills/tree/HEAD/find-skills",
      },
    });
  });

  it("rejects other hosts without fetching", async () => {
    const res = await post({ url: "https://example.com/o/r/SKILL.md" });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Only GitHub and skills.sh links can be imported",
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("returns 422 when SKILL.md fails validation", async () => {
    mocks.fetch.mockResolvedValue(new Response("# No frontmatter"));

    const res = await post({ url: "o/r/x" });

    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/frontmatter/);
  });

  it("rate limits previews per user", async () => {
    for (let i = 0; i < SKILL_IMPORT_RATE_LIMIT.limit; i++) {
      await post({ url: "o/r/x" });
    }

    const res = await post({ url: "o/r/x" });

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });
});
