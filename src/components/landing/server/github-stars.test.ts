import { afterEach, describe, expect, it, vi } from "vitest";

import { getGithubStars } from "./github-stars";

afterEach(() => vi.unstubAllGlobals());

describe("getGithubStars (#246)", () => {
  it.each([0, 1234])("fetches %i public stars with an hourly cache and timeout, without auth", async (stars) => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ private: false, stargazers_count: stars }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await getGithubStars()).toBe(stars);
    expect(fetchMock).toHaveBeenCalledWith("https://api.github.com/repos/itsmrad/codenaya", {
      next: { revalidate: 3600 }, signal: expect.any(AbortSignal),
    });
  });

  it.each([
    { private: true, stargazers_count: 123 },
    { private: false, stargazers_count: -1 },
    { private: false, stargazers_count: "123" },
    { private: false, stargazers_count: 1.5 },
    {},
  ])("hides private or malformed counts: %j", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
    expect(await getGithubStars()).toBeNull();
  });

  it.each([403, 404, 429, 500])("hides the count on HTTP %i", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status })));
    expect(await getGithubStars()).toBeNull();
  });

  it.each([new DOMException("Timed out", "TimeoutError"), new TypeError("Network failure")])(
    "hides the count when fetch fails: %s", async (error) => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
      expect(await getGithubStars()).toBeNull();
    },
  );

  it("hides invalid JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("invalid")));
    expect(await getGithubStars()).toBeNull();
  });
});
