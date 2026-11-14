/**
 * The sandbox routes answer 400 for a malformed or invalid body, before they
 * touch Convex or E2B (#235).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  query: vi.fn(),
  sandboxCreate: vi.fn(),
  sandboxConnect: vi.fn(),
  sandboxList: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("@/lib/convex-client", () => ({ convex: { query: mocks.query } }));
vi.mock("e2b", () => ({
  Sandbox: {
    create: mocks.sandboxCreate,
    connect: mocks.sandboxConnect,
    list: mocks.sandboxList,
  },
  AuthenticationError: class extends Error {},
  RateLimitError: class extends Error {},
}));

import { POST } from "./route";
import {
  SANDBOX_CREATE_RATE_LIMIT,
  checkRateLimit,
  resetRateLimits,
} from "@/lib/rate-limit";
import { MAX_LIVE_SANDBOXES } from "@/features/sandbox-preview/server/project-sandbox";
import { PATCH } from "./[sandboxId]/route";

const params = { params: Promise.resolve({ sandboxId: "sbx_1" }) };

const request = (method: string, body: string) =>
  new Request("http://localhost/api/sandbox", { method, body });

const routes = [
  { name: "POST /api/sandbox", call: (body: string) => POST(request("POST", body)) },
  {
    name: "PATCH /api/sandbox/[sandboxId]",
    call: (body: string) => PATCH(request("PATCH", body), params),
  },
];

beforeEach(() => {
  vi.resetAllMocks();
  resetRateLimits();
  vi.stubEnv("E2B_API_KEY", "e2b-test");
  mocks.auth.mockResolvedValue({ userId: "user_1" });
});

describe.each(routes)("$name", ({ call }) => {
  it.each([
    ["malformed JSON", "{not json"],
    ["a missing files array", "{}"],
    ["files that are not an array", '{"files":"index.js"}'],
    ["an empty files array", '{"files":[]}'],
    ["a file without content", '{"files":[{"path":"index.js"}]}'],
    // POST reads `settings.devCommand`, PATCH reads `installCommand`.
    [
      "a non-string command",
      '{"files":[{"path":"a.js","content":""}],"settings":{"devCommand":1},"installCommand":1}',
    ],
  ])("answers 400 for %s without touching Convex or E2B", async (_case, body) => {
    const res = await call(body);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Invalid request" });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.sandboxCreate).not.toHaveBeenCalled();
    expect(mocks.sandboxConnect).not.toHaveBeenCalled();
  });
});

describe("POST /api/sandbox cost caps (#242)", () => {
  const boot = () =>
    POST(request("POST", JSON.stringify({ files: [{ path: "index.html", content: "" }] })));
  const liveSandboxes = (count: number) =>
    mocks.sandboxList.mockReturnValue({
      nextItems: async () => Array.from({ length: count }, (_, i) => ({ sandboxId: `sbx_${i}` })),
    });

  it("answers 429 past the per-user rate limit without asking E2B", async () => {
    for (let i = 0; i < SANDBOX_CREATE_RATE_LIMIT.limit; i++) {
      checkRateLimit("user_1", SANDBOX_CREATE_RATE_LIMIT);
    }

    const res = await boot();

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(mocks.sandboxList).not.toHaveBeenCalled();
    expect(mocks.sandboxCreate).not.toHaveBeenCalled();
  });

  it("answers 429 rate_limit when the user already has the max live sandboxes", async () => {
    liveSandboxes(MAX_LIVE_SANDBOXES);

    const res = await boot();

    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: "rate_limit" });
    expect(mocks.sandboxList).toHaveBeenCalledWith(
      expect.objectContaining({
        query: { metadata: { userId: "user_1" }, state: ["running"] },
      }),
    );
    expect(mocks.sandboxCreate).not.toHaveBeenCalled();
  });

  it("boots below the cap", async () => {
    liveSandboxes(MAX_LIVE_SANDBOXES - 1);
    mocks.sandboxCreate.mockRejectedValue(new Error("stop after the cap check"));

    const res = await boot();

    expect(res.status).toBe(200);
    await res.text();
    expect(mocks.sandboxCreate).toHaveBeenCalled();
  });
});

describe("POST /api/sandbox tags (#465)", () => {
  const boot = (projectId?: string) =>
    POST(
      request(
        "POST",
        JSON.stringify({ files: [{ path: "index.html", content: "" }], projectId }),
      ),
    );

  beforeEach(() => {
    mocks.sandboxList.mockReturnValue({ nextItems: async () => [] });
    mocks.sandboxCreate.mockRejectedValue(new Error("stop after create"));
  });

  it("tags a project's preview with its owner and project, so checkBuild can find it", async () => {
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "internal");
    mocks.query.mockImplementation(async (_ref, args: Record<string, unknown>) =>
      "userId" in args ? { _id: "proj_1", ownerId: "user_1" } : [],
    );

    await (await boot("proj_1")).text();

    expect(mocks.sandboxCreate).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ metadata: { userId: "user_1", projectId: "proj_1" } }),
    );
  });

  it("tags a preview without a project with its owner only", async () => {
    await (await boot()).text();

    expect(mocks.sandboxCreate).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ metadata: { userId: "user_1" } }),
    );
  });
});

describe("POST /api/sandbox past its time budget (#492)", () => {
  const boot = (extra: Record<string, unknown> = {}) =>
    POST(
      request(
        "POST",
        JSON.stringify({ files: [{ path: "index.html", content: "" }], ...extra }),
      ),
    );

  const events = async (res: Response) =>
    (await res.text())
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  const fakeSandbox = (sandboxId: string, ownerId = "user_1") => ({
    sandboxId,
    getInfo: vi.fn(async () => ({ metadata: { userId: ownerId } })),
    kill: vi.fn(),
    commands: {
      list: vi.fn(async () => [{ pid: 7 }, { pid: 8 }]),
      kill: vi.fn(async () => true),
      run: vi.fn(async () => {
        throw new Error("stop after connect");
      }),
    },
  });

  beforeEach(() => {
    mocks.sandboxList.mockReturnValue({ nextItems: async () => [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hands the sandbox to the client to resume instead of failing it", async () => {
    const startedAt = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    const sandbox = fakeSandbox("sbx_slow");
    mocks.sandboxCreate.mockImplementation(async () => {
      now.mockReturnValue(startedAt + 280_000);
      return sandbox;
    });

    const sent = await events(await boot());

    expect(sent).toContainEqual({ type: "resume", sandboxId: "sbx_slow" });
    expect(sent.some((event) => event.type === "error")).toBe(false);
    expect(sandbox.kill).not.toHaveBeenCalled();
  });

  it("resumes on the caller's sandbox without creating one or checking the cap", async () => {
    const sandbox = fakeSandbox("sbx_resume");
    mocks.sandboxConnect.mockResolvedValue(sandbox);

    await (await boot({ resumeSandboxId: "sbx_resume" })).text();

    expect(mocks.sandboxConnect).toHaveBeenCalledWith("sbx_resume");
    expect(sandbox.commands.kill).toHaveBeenCalledWith(7);
    expect(sandbox.commands.kill).toHaveBeenCalledWith(8);
    expect(mocks.sandboxCreate).not.toHaveBeenCalled();
    expect(mocks.sandboxList).not.toHaveBeenCalled();
  });

  it("refuses to resume another user's sandbox", async () => {
    const sandbox = fakeSandbox("sbx_other", "user_2");
    mocks.sandboxConnect.mockResolvedValue(sandbox);

    const sent = await events(await boot({ resumeSandboxId: "sbx_other" }));

    expect(sent).toContainEqual(
      expect.objectContaining({ type: "error", message: "Sandbox not found" }),
    );
    expect(sandbox.commands.kill).not.toHaveBeenCalled();
    expect(mocks.sandboxCreate).not.toHaveBeenCalled();
  });
});
