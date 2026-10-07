import { describe, expect, it, vi } from "vitest";

import {
  SKILL_MD_MAX_BYTES,
  fetchSkillMd,
  githubFolderUrl,
  parseSkillSource,
  rawSkillMdUrl,
} from "./github-source";

describe("parseSkillSource", () => {
  it.each([
    [
      "https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices",
      { owner: "vercel-labs", repo: "agent-skills", ref: "main", paths: ["skills/react-best-practices"] },
    ],
    [
      "https://github.com/o/r/blob/v1.2/skills/x/SKILL.md",
      { owner: "o", repo: "r", ref: "v1.2", paths: ["skills/x"] },
    ],
    ["github.com/o/r", { owner: "o", repo: "r", ref: "HEAD", paths: [""] }],
    [
      "https://raw.githubusercontent.com/o/r/abc123/a/b/SKILL.md",
      { owner: "o", repo: "r", ref: "abc123", paths: ["a/b"] },
    ],
    ["o/r/skills/x", { owner: "o", repo: "r", ref: "HEAD", paths: ["skills/x"] }],
    [
      "https://skills.sh/vercel-labs/skills/find-skills",
      { owner: "vercel-labs", repo: "skills", ref: "HEAD", paths: ["skills/find-skills", "find-skills"] },
    ],
    [
      "skills.sh/o/solo/solo",
      { owner: "o", repo: "solo", ref: "HEAD", paths: ["skills/solo", "solo", ""] },
    ],
  ])("parses %s", (input, expected) => {
    expect(parseSkillSource(input)).toEqual(expected);
  });

  it("rejects hosts other than GitHub and skills.sh", () => {
    expect(() => parseSkillSource("https://evil.example/o/r/tree/main/x")).toThrow(
      /Only GitHub and skills.sh/,
    );
    expect(() => parseSkillSource("https://gist.github.com/o/r")).toThrow(
      /Only GitHub and skills.sh/,
    );
  });

  it.each([
    "",
    "not a url",
    "o",
    "https://github.com/o/r/issues/1",
    "https://github.com/o/r/tree/main/../../x",
    "o/r/../x",
    "https://github.com/o/r/tree/main/a%2F..%2Fb",
    "https://skills.sh/o/r",
    "ftp://github.com/o/r",
  ])("rejects %j", (input) => {
    expect(() => parseSkillSource(input)).toThrow(/Paste a GitHub folder URL/);
  });

  it("builds raw and github.com URLs from a source", () => {
    const source = parseSkillSource("o/r/skills/x");

    expect(rawSkillMdUrl(source, "skills/x")).toBe(
      "https://raw.githubusercontent.com/o/r/HEAD/skills/x/SKILL.md",
    );
    expect(rawSkillMdUrl(source, "")).toBe(
      "https://raw.githubusercontent.com/o/r/HEAD/SKILL.md",
    );
    expect(githubFolderUrl(source, "skills/x")).toBe(
      "https://github.com/o/r/tree/HEAD/skills/x",
    );
  });
});

describe("fetchSkillMd", () => {
  const source = parseSkillSource("https://skills.sh/o/r/x");

  it("tries each candidate folder on raw.githubusercontent.com only", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response("---\nname: x\n---\n"));

    const result = await fetchSkillMd(source, fetchMock);

    expect(result).toEqual({ text: "---\nname: x\n---\n", path: "x" });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://raw.githubusercontent.com/o/r/HEAD/skills/x/SKILL.md",
      "https://raw.githubusercontent.com/o/r/HEAD/x/SKILL.md",
    ]);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "error" });
  });

  it("reports 404 when no folder has a SKILL.md", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("", { status: 404 }));

    await expect(fetchSkillMd(source, fetchMock)).rejects.toMatchObject({
      status: 404,
      message: expect.stringMatching(/No SKILL.md/),
    });
  });

  it("rejects files over 64 KB", async () => {
    const big = "a".repeat(SKILL_MD_MAX_BYTES + 1);
    const declared = vi.fn<typeof fetch>().mockResolvedValue(new Response(big));
    // A streamed body without Content-Length is cut off at the cap too.
    const streamed = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(big));
            controller.close();
          },
        }),
      ),
    );

    for (const fetchMock of [declared, streamed]) {
      await expect(fetchSkillMd(source, fetchMock)).rejects.toMatchObject({
        status: 413,
      });
    }
  });

  it("maps timeouts and network failures to gateway errors", async () => {
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });

    await expect(
      fetchSkillMd(source, vi.fn<typeof fetch>().mockRejectedValue(timeout)),
    ).rejects.toMatchObject({ status: 504 });
    await expect(
      fetchSkillMd(source, vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"))),
    ).rejects.toMatchObject({ status: 502 });
  });
});
