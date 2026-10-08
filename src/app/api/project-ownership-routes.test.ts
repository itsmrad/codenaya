/**
 * Every route that takes a project, conversation or sandbox id from the client
 * answers 404 for one the caller does not own, before it reads secrets, writes
 * to Convex, sends an Inngest event or touches a sandbox (#208).
 */

import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  query: vi.fn(),
  mutation: vi.fn(),
  inngestSend: vi.fn(),
  getUserOauthAccessToken: vi.fn(),
  sandboxCreate: vi.fn(),
  sandboxConnect: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: mocks.auth,
  clerkClient: async () => ({
    users: { getUserOauthAccessToken: mocks.getUserOauthAccessToken },
  }),
}));
vi.mock("@/lib/convex-client", () => ({
  convex: { query: mocks.query, mutation: mocks.mutation },
}));
vi.mock("@/inngest/client", () => ({
  inngest: { send: mocks.inngestSend },
}));
// Instantiates the Workflow SDK at import time; only the Inngest path is used.
vi.mock("@/features/conversations/workflow/client", () => ({
  startProcessMessageWorkflow: vi.fn(),
  cancelProcessMessageWorkflowByMessageId: vi.fn(),
}));
vi.mock("e2b", () => ({
  Sandbox: { create: mocks.sandboxCreate, connect: mocks.sandboxConnect },
  AuthenticationError: class extends Error {},
  RateLimitError: class extends Error {},
}));

import { POST as sandboxPOST } from "./sandbox/route";
import {
  DELETE as sandboxDELETE,
  PATCH as sandboxPATCH,
} from "./sandbox/[sandboxId]/route";
import { POST as messagesPOST } from "./messages/route";
import { POST as messagesCancelPOST } from "./messages/cancel/route";
import { POST as exportPOST } from "./github/export/route";
import { POST as exportCancelPOST } from "./github/export/cancel/route";
import { POST as exportResetPOST } from "./github/export/reset/route";
import { POST as envVarsPOST } from "./env-vars/route";
import { POST as connectPOST } from "./integrations/connect/route";
import { POST as oauthStartPOST } from "./integrations/oauth/start/route";

const ATTACKER = "user_attacker";
const VICTIM_PROJECT = "victim_project";
const VICTIM_CONVERSATION = "victim_conversation";
const OWNERSHIP_QUERIES = ["system:getOwnedProject", "system:getOwnedConversation"];

const request = (body: unknown, method = "POST") =>
  new Request("http://localhost/api", { method, body: JSON.stringify(body) });

const sandboxParams = { params: Promise.resolve({ sandboxId: "victim_sandbox" }) };

const routes = [
  {
    name: "POST /api/sandbox",
    call: () =>
      sandboxPOST(
        request({
          projectId: VICTIM_PROJECT,
          files: [{ path: "index.js", content: "" }],
          settings: { devCommand: "echo $SECRET | base64" },
        }),
      ),
  },
  {
    name: "POST /api/messages",
    call: () =>
      messagesPOST(request({ conversationId: VICTIM_CONVERSATION, message: "Delete everything" })),
  },
  {
    name: "POST /api/messages/cancel",
    call: () => messagesCancelPOST(request({ projectId: VICTIM_PROJECT })),
  },
  {
    name: "POST /api/github/export",
    call: () => exportPOST(request({ projectId: VICTIM_PROJECT, repoName: "loot" })),
  },
  {
    name: "POST /api/github/export/cancel",
    call: () => exportCancelPOST(request({ projectId: VICTIM_PROJECT })),
  },
  {
    name: "POST /api/github/export/reset",
    call: () => exportResetPOST(request({ projectId: VICTIM_PROJECT })),
  },
  {
    name: "POST /api/env-vars",
    call: () =>
      envVarsPOST(request({ projectId: VICTIM_PROJECT, key: "API_SECRET", value: "x" })),
  },
  {
    name: "POST /api/integrations/connect",
    call: () =>
      connectPOST(request({ providerId: "supabase", apiKey: "sk", projectId: VICTIM_PROJECT })),
  },
  {
    name: "POST /api/integrations/oauth/start",
    call: () => oauthStartPOST(request({ providerId: "supabase", projectId: VICTIM_PROJECT })),
  },
];

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "test-key");
  vi.stubEnv("E2B_API_KEY", "e2b-test");
  vi.stubEnv("MESSAGE_PROCESSOR", "inngest");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.auth.mockResolvedValue({ userId: ATTACKER, has: () => false });
  // The attacker owns nothing they name.
  mocks.query.mockImplementation(async (ref) =>
    OWNERSHIP_QUERIES.includes(getFunctionName(ref)) ? null : [],
  );
  mocks.getUserOauthAccessToken.mockResolvedValue({ data: [{ token: "gho_attacker" }] });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe.each(routes)("$name with someone else's id", ({ call }) => {
  it("answers 404 and has no side effects", async () => {
    const res = await call();

    expect(res.status).toBe(404);
    // Only the ownership check ran: no secrets, messages or files were read.
    const queried = mocks.query.mock.calls.map(([ref]) => getFunctionName(ref));
    expect(queried.length).toBeGreaterThan(0);
    expect(queried.every((name) => OWNERSHIP_QUERIES.includes(name))).toBe(true);
    // The check is made for the signed-in user, not one named by the client.
    expect(mocks.query).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: ATTACKER }),
    );
    expect(mocks.mutation).not.toHaveBeenCalled();
    expect(mocks.inngestSend).not.toHaveBeenCalled();
    expect(mocks.sandboxCreate).not.toHaveBeenCalled();
  });
});

describe("/api/sandbox/[sandboxId] with someone else's sandbox", () => {
  const sandbox = {
    getInfo: vi.fn(),
    kill: vi.fn(),
    files: { write: vi.fn() },
  };

  beforeEach(() => {
    sandbox.getInfo.mockResolvedValue({ metadata: { userId: "user_victim" } });
    mocks.sandboxConnect.mockResolvedValue(sandbox);
  });

  it.each([
    ["DELETE", () => sandboxDELETE(request({}, "DELETE"), sandboxParams)],
    [
      "PATCH",
      () => sandboxPATCH(request({ files: [{ path: "a.js", content: "" }] }, "PATCH"), sandboxParams),
    ],
  ])("%s answers 404 without touching it", async (_method, call) => {
    const res = await call();

    expect(res.status).toBe(404);
    expect(sandbox.kill).not.toHaveBeenCalled();
    expect(sandbox.files.write).not.toHaveBeenCalled();
  });
});
