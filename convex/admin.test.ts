// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const ADMIN = { subject: "user_admin", email: "admin@example.com", emailVerified: true };
const OTHER = { subject: "user_other", email: "other@example.com", emailVerified: true };

const INTERNAL_KEY = "test-internal-key";
const MODEL = {
  id: "openai/gpt-5.4-mini",
  name: "GPT-5.4 mini",
  vendor: "openai",
  provider: "openrouter" as const,
  providerModelId: "openai/gpt-5.4-mini",
  vision: true,
  tools: "reported" as const,
  pricing: { mode: "blended" as const, usdPerMTok: 0.69 },
  access: "everyone" as const,
  hidden: false,
};
const SAVE = {
  internalKey: INTERNAL_KEY,
  models: [MODEL],
  defaultModelId: MODEL.id,
  utilityModelId: MODEL.id,
  confirmRiskyPrices: false,
  request: { requestId: "req_1" },
};
const PAGE = { paginationOpts: { numItems: 10, cursor: null } };

const setup = () => convexTest(schema, modules);

const expectNotFound = (promise: Promise<unknown>) =>
  expect(promise).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });

beforeEach(() => {
  vi.stubEnv("ADMIN_EMAIL", "admin@example.com");
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", INTERNAL_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("requireAdmin", () => {
  test("the admin can save, and exactly one audit row is written", async () => {
    const t = setup();
    const admin = t.withIdentity(ADMIN);

    expect(await admin.query(api.admin.isAdmin, {})).toBe(true);
    await admin.mutation(api.platformCatalog.save, SAVE);

    const audit = await admin.query(api.admin.listAudit, PAGE);
    expect(audit.page).toHaveLength(1);
    expect(audit.page[0]).toMatchObject({
      actorId: ADMIN.subject,
      actorEmail: ADMIN.email,
      action: "platformCatalog.save",
    });
  });

  test("a non-admin gets NOT_FOUND from every admin function", async () => {
    const t = setup();
    const other = t.withIdentity(OTHER);

    expect(await other.query(api.admin.isAdmin, {})).toBe(false);
    await expectNotFound(other.mutation(api.platformCatalog.save, SAVE));
    await expectNotFound(other.query(api.admin.listAudit, PAGE));
    await expectNotFound(other.query(api.platformCatalog.getForAdmin, {}));
  });

  test("signed out is not admin", async () => {
    const t = setup();
    expect(await t.query(api.admin.isAdmin, {})).toBe(false);
    await expectNotFound(t.mutation(api.platformCatalog.save, SAVE));
  });

  test("an unverified admin email is not admin", async () => {
    const t = setup();
    const unverified = t.withIdentity({ ...ADMIN, emailVerified: false });

    expect(await unverified.query(api.admin.isAdmin, {})).toBe(false);
    await expectNotFound(unverified.mutation(api.platformCatalog.save, SAVE));
    // A missing claim counts as unverified too.
    expect(
      await t.withIdentity({ ...ADMIN, emailVerified: undefined }).query(api.admin.isAdmin, {}),
    ).toBe(false);
  });

  test("with ADMIN_EMAIL unset nobody is admin", async () => {
    vi.stubEnv("ADMIN_EMAIL", "");
    const t = setup();
    const admin = t.withIdentity(ADMIN);

    expect(await admin.query(api.admin.isAdmin, {})).toBe(false);
    await expectNotFound(admin.mutation(api.platformCatalog.save, SAVE));
  });

  test("case and whitespace variants of the email match", async () => {
    vi.stubEnv("ADMIN_EMAIL", "  Admin@Example.COM ");
    const t = setup();

    expect(
      await t
        .withIdentity({ ...ADMIN, email: "ADMIN@example.com" })
        .query(api.admin.isAdmin, {}),
    ).toBe(true);
  });
});

describe("ADMIN_USER_ID pin", () => {
  test("when set, the verified email must also be that Clerk user", async () => {
    vi.stubEnv("ADMIN_USER_ID", ` ${ADMIN.subject} `);
    const t = setup();

    expect(await t.withIdentity(ADMIN).query(api.admin.isAdmin, {})).toBe(true);
    const impostor = t.withIdentity({ ...ADMIN, subject: "user_impostor" });
    expect(await impostor.query(api.admin.isAdmin, {})).toBe(false);
    await expectNotFound(impostor.mutation(api.platformCatalog.save, SAVE));
    await expectNotFound(impostor.query(api.admin.listAudit, PAGE));
  });

  test("the user id alone is not enough", async () => {
    vi.stubEnv("ADMIN_USER_ID", ADMIN.subject);
    const t = setup();
    expect(
      await t.withIdentity({ ...ADMIN, email: "other@example.com" }).query(api.admin.isAdmin, {}),
    ).toBe(false);
  });
});

describe("listAudit", () => {
  const CATALOG_MODEL = {
    id: "a",
    name: "A",
    vendor: "acme",
    provider: "openrouter" as const,
    providerModelId: "acme/a",
    vision: false,
    tools: "reported" as const,
    pricing: { mode: "blended" as const, usdPerMTok: 8 },
    access: "everyone" as const,
    hidden: false,
  };

  test("returns the request and structured changes, bounded", async () => {
    const admin = setup().withIdentity(ADMIN);
    await admin.mutation(api.platformCatalog.save, {
      internalKey: INTERNAL_KEY,
      models: [CATALOG_MODEL],
      defaultModelId: "a",
      utilityModelId: "a",
      confirmRiskyPrices: false,
      request: { requestId: "req_1", ip: "203.0.113.7", userAgent: "x".repeat(2000) },
    });

    const [row] = (await admin.query(api.admin.listAudit, PAGE)).page;
    expect(row).toMatchObject({ action: "platformCatalog.save", requestId: "req_1", ip: "203.0.113.7" });
    expect(row.userAgent).toHaveLength(500);
    expect(row.changes?.map((c) => c.field)).toEqual(["model:a", "defaultModelId", "utilityModelId"]);
  });

  test("a non-admin gets NOT_FOUND", async () => {
    await expectNotFound(setup().withIdentity(OTHER).query(api.admin.listAudit, PAGE));
  });
});
