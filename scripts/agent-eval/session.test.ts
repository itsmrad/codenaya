import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureTestUser, findUsers, revokeStaleSessions } from "../../e2e/clerk-auth";
import { sanitize } from "./capture";
import { adminUser, evalUser } from "./session";

vi.mock("../../e2e/clerk-auth", () => ({
  findUsers: vi.fn(),
  ensureTestUser: vi.fn(async () => ({ id: "user_eval" })),
  revokeStaleSessions: vi.fn(),
  revokeSession: vi.fn(),
  addTestingToken: vi.fn(),
  signInWithTicket: vi.fn(),
}));

const EMAIL = "owner@example.com";

describe("admin user", () => {
  beforeEach(() => { process.env.ADMIN_EMAIL = ` ${EMAIL} `; });
  afterEach(() => { delete process.env.ADMIN_EMAIL; vi.clearAllMocks(); });

  it("requires exactly one Clerk user and never names the email", async () => {
    for (const users of [[], [{ id: "a" }, { id: "b" }]]) {
      vi.mocked(findUsers).mockResolvedValueOnce(users);
      const error = await adminUser().catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(`found ${users.length}`);
      expect((error as Error).message).not.toContain(EMAIL);
    }
    expect(findUsers).toHaveBeenCalledWith(EMAIL);
  });

  it("looks the admin up without creating it or revoking its sessions", async () => {
    vi.mocked(findUsers).mockResolvedValueOnce([{ id: "user_admin" }]);
    expect(await evalUser(true)).toEqual({ id: "user_admin" });
    expect(ensureTestUser).not.toHaveBeenCalled();
    expect(revokeStaleSessions).not.toHaveBeenCalled();
    expect(await evalUser(false)).toEqual({ id: "user_eval" });
    expect(revokeStaleSessions).toHaveBeenCalledWith("user_eval");
  });

  it("redacts the admin email in any case", () => {
    expect(sanitize({ error: `as Owner@Example.COM and ${EMAIL}` })).not.toMatch(/owner@example\.com/i);
  });
});
