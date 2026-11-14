import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  query: vi.fn(),
  resolveProjectEnv: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("@/lib/convex-client", () => ({ convex: { query: mocks.query } }));
vi.mock("@/features/integrations/server/env/resolve-env", () => ({
  resolveProjectEnv: mocks.resolveProjectEnv,
}));

import { resetRateLimits } from "@/lib/rate-limit";
import { POST } from "./route";

const SECRET = "hunter2-password-123";

const post = (body: unknown) =>
  new Request("http://localhost/api/projects/security-scan", {
    method: "POST",
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.resetAllMocks();
  resetRateLimits();
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "test-key");
  mocks.auth.mockResolvedValue({ userId: "user_1", has: () => false });
  mocks.query.mockImplementation(async (ref) => {
    switch (getFunctionName(ref)) {
      case "system:getOwnedProject":
        return { _id: "p1", ownerId: "user_1" };
      case "system:getProjectFilesWithUrls":
        return [
          { _id: "d", type: "folder", name: "src" },
          { _id: "f", type: "file", name: "db.ts", parentId: "d", content: `connect("${SECRET}")` },
          { _id: "b", type: "file", name: "logo.png", storageId: "s", storageUrl: "u" },
        ];
      default:
        return [];
    }
  });
  mocks.resolveProjectEnv.mockResolvedValue({
    publicEntries: [],
    secretEntries: [{ key: "DB_PASSWORD", value: SECRET }],
    failedKeys: [],
  });
});

describe("POST /api/projects/security-scan", () => {
  it("returns 401 when signed out", async () => {
    mocks.auth.mockResolvedValue({ userId: null, has: () => false });

    expect((await POST(post({ projectId: "p1" }))).status).toBe(401);
  });

  it("returns 400 without a project id", async () => {
    expect((await POST(post({}))).status).toBe(400);
  });

  it("returns findings with paths and rules, never the secret value", async () => {
    const res = await POST(post({ projectId: "p1" }));
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual({
      findings: [{ file: "src/db.ts", line: 1, rule: "stored-secret", severity: "high" }],
    });
    expect(text).not.toContain(SECRET);
  });
});
