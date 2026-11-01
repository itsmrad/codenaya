// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { MAX_PLATFORM_MODELS } from "../src/features/admin/platform-models";
import type { CatalogModel } from "../src/features/ai-providers/catalog";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const ADMIN = { subject: "user_admin", email: "admin@example.com", emailVerified: true };
const OTHER = { subject: "user_other", email: "other@example.com", emailVerified: true };
const INTERNAL_KEY = "test-internal-key";
const REQUEST = { requestId: "req_1", ip: "203.0.113.7", userAgent: "vitest" };
const PAGE = { paginationOpts: { numItems: 10, cursor: null } };

const model = (id: string, overrides: Partial<CatalogModel> = {}): CatalogModel => ({
  id,
  name: id.toUpperCase(),
  vendor: "acme",
  provider: "openrouter",
  providerModelId: `acme/${id}`,
  vision: false,
  tools: "reported",
  pricing: { mode: "blended", usdPerMTok: 8 },
  access: "everyone",
  hidden: false,
  ...overrides,
});

const setup = () => convexTest(schema, modules);
const asAdmin = () => setup().withIdentity(ADMIN);
type Caller = ReturnType<typeof asAdmin>;

const save = (
  t: Caller,
  models: CatalogModel[],
  overrides: Partial<{
    defaultModelId: string;
    utilityModelId: string;
    confirmRiskyPrices: boolean;
    internalKey: string;
  }> = {},
) =>
  t.mutation(api.platformCatalog.save, {
    internalKey: INTERNAL_KEY,
    models,
    defaultModelId: models[0]?.id ?? "",
    utilityModelId: models[0]?.id ?? "",
    confirmRiskyPrices: false,
    request: REQUEST,
    ...overrides,
  });

const auditRows = async (t: Caller) =>
  (await t.query(api.admin.listAudit, PAGE)).page;

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: { data?: { code?: string; reason?: string } }) => error.data,
  );

beforeEach(() => {
  vi.stubEnv("ADMIN_EMAIL", ADMIN.email);
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", INTERNAL_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("platformCatalog admin gate", () => {
  test("refuses non-admins, a wrong ADMIN_USER_ID and unverified emails", async () => {
    const base = setup();
    const callers = [
      base,
      base.withIdentity(OTHER),
      base.withIdentity({ ...ADMIN, emailVerified: false }),
    ];
    for (const t of callers) {
      expect(await codeOf(save(t, [model("a")]))).toMatchObject({ code: "NOT_FOUND" });
      expect(await codeOf(t.query(api.platformCatalog.getForAdmin, {}))).toMatchObject({
        code: "NOT_FOUND",
      });
    }

    vi.stubEnv("ADMIN_USER_ID", "user_someone_else");
    const admin = base.withIdentity(ADMIN);
    expect(await codeOf(save(admin, [model("a")]))).toMatchObject({ code: "NOT_FOUND" });
    expect(await codeOf(admin.query(api.platformCatalog.getForAdmin, {}))).toMatchObject({
      code: "NOT_FOUND",
    });
  });

  test("the admin needs the internal key to save", async () => {
    const t = asAdmin();
    expect(await codeOf(save(t, [model("a")], { internalKey: "guess" }))).toMatchObject({
      code: "UNAUTHENTICATED",
    });
    expect(await t.query(api.platformCatalog.getForAdmin, {})).toBeNull();
  });

  test("a matching ADMIN_USER_ID lets the admin save", async () => {
    vi.stubEnv("ADMIN_USER_ID", ADMIN.subject);
    const t = asAdmin();
    await save(t, [model("a")]);
    expect(await t.query(api.platformCatalog.getForAdmin, {})).toMatchObject({
      defaultModelId: "a",
      utilityModelId: "a",
      updatedBy: ADMIN.subject,
    });
  });
});

describe("platformCatalog.save validation", () => {
  test.each([
    ["no models", [], {}],
    ["more than 50 models", Array.from({ length: 51 }, (_, i) => model(`m${i}`)), {}],
    ["duplicate ids", [model("a"), model("a")], {}],
    ["an empty provider model id", [model("a", { providerModelId: "" })], {}],
    ["a too long provider model id", [model("a", { providerModelId: "x".repeat(201) })], {}],
    ["a negative price", [model("a", { pricing: { mode: "blended", usdPerMTok: -1 } })], {}],
    [
      "a NaN split price",
      [model("a", { pricing: { mode: "split", inputUsdPerMTok: 1, outputUsdPerMTok: Number.NaN } })],
      {},
    ],
    ["a price over $1000/M", [model("a", { pricing: { mode: "blended", usdPerMTok: 1001 } })], {}],
    ["a fractional context length", [model("a", { contextLength: 1.5 })], {}],
    ["an empty name", [model("a", { name: " " })], {}],
    ["images on the Anthropic route", [model("a", { provider: "anthropic", vision: true })], {}],
    ["a default that isn't listed", [model("a")], { defaultModelId: "b" }],
    ["a hidden default", [model("a", { hidden: true }), model("b")], { utilityModelId: "b" }],
    [
      "a promo default",
      [model("a", { access: "promo_counted" }), model("b")],
      { utilityModelId: "b" },
    ],
    [
      "a promo utility model",
      [model("a"), model("b", { access: "promo_unlimited" })],
      { utilityModelId: "b" },
    ],
  ])("rejects %s", async (_, models, overrides) => {
    const t = asAdmin();
    expect(await codeOf(save(t, models, { confirmRiskyPrices: true, ...overrides }))).toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(await auditRows(t)).toEqual([]);
  });
});

describe("platformCatalog.save price guard", () => {
  test("a $0 price needs confirming", async () => {
    const t = asAdmin();
    const free = [model("a"), model("free", { pricing: { mode: "blended", usdPerMTok: 0 } })];
    expect(await codeOf(save(t, free))).toMatchObject({ code: "CONFLICT", reason: "risky_price" });
    expect(await t.query(api.platformCatalog.getForAdmin, {})).toBeNull();

    await save(t, free, { confirmRiskyPrices: true });
    expect((await t.query(api.platformCatalog.getForAdmin, {}))?.models).toHaveLength(2);

    // Saved once, an unchanged $0 price doesn't ask again.
    await save(t, [...free, model("b")]);
    expect((await t.query(api.platformCatalog.getForAdmin, {}))?.models).toHaveLength(3);
  });

  test("a hidden utility model is allowed, for titles users don't pick", async () => {
    const t = asAdmin();
    await save(t, [model("a"), model("mini", { hidden: true })], { utilityModelId: "mini" });
    expect((await t.query(api.platformCatalog.getForAdmin, {}))?.utilityModelId).toBe("mini");
  });

  test("a blended change over 50% needs confirming, a smaller one doesn't", async () => {
    const t = asAdmin();
    await save(t, [model("a")]);
    // $4 in / $20 out blends to $8: unchanged.
    await save(t, [model("a", { pricing: { mode: "split", inputUsdPerMTok: 4, outputUsdPerMTok: 20 } })]);
    await save(t, [model("a", { pricing: { mode: "blended", usdPerMTok: 12 } })]);

    const tripled = [model("a", { pricing: { mode: "blended", usdPerMTok: 36 } })];
    const refused = await codeOf(save(t, tripled));
    expect(refused).toMatchObject({ code: "CONFLICT", reason: "risky_price" });
    expect((refused as { message: string }).message).toContain("a");

    await save(t, tripled, { confirmRiskyPrices: true });
    expect((await t.query(api.platformCatalog.getForAdmin, {}))?.models[0].pricing).toEqual({
      mode: "blended",
      usdPerMTok: 36,
    });
  });
});

describe("platformCatalog.save audit", () => {
  test("records structured changes for a re-route and a reprice, with the request", async () => {
    const t = asAdmin();
    await save(t, [model("a"), model("b")]);
    await save(
      t,
      [
        model("a", { provider: "anthropic", providerModelId: "claude-a" }),
        model("c", { pricing: { mode: "split", inputUsdPerMTok: 4, outputUsdPerMTok: 20 } }),
      ],
      { utilityModelId: "c" },
    );
    await save(
      t,
      [
        model("a", {
          provider: "anthropic",
          providerModelId: "claude-a",
          pricing: { mode: "blended", usdPerMTok: 10 },
        }),
        model("c", { pricing: { mode: "split", inputUsdPerMTok: 4, outputUsdPerMTok: 20 } }),
      ],
      { utilityModelId: "c" },
    );

    const [reprice, reroute, first] = await auditRows(t);
    expect(first).toMatchObject({
      action: "platformCatalog.save",
      actorId: ADMIN.subject,
      summary: "added a ($8/M on openrouter), b ($8/M on openrouter); default → a; utility → a",
      ...REQUEST,
    });

    expect(reroute.summary).toBe(
      "added c ($4/$20 per M on openrouter); removed b; " +
        "re-routed a: openrouter:acme/a → anthropic:claude-a; utility → c",
    );
    // Added and removed models are logged whole, as JSON.
    const parse = (json?: string) => JSON.parse(json ?? "null") as unknown;
    const [addedC, removedB, ...edits] = reroute.changes ?? [];
    expect(addedC.field).toBe("model:c");
    expect(parse(addedC.after)).toEqual(
      model("c", { pricing: { mode: "split", inputUsdPerMTok: 4, outputUsdPerMTok: 20 } }),
    );
    expect(removedB.field).toBe("model:b");
    expect(removedB.after).toBeUndefined();
    expect(parse(removedB.before)).toEqual(model("b"));
    expect(edits).toEqual([
      { field: "model:a.provider", before: "openrouter", after: "anthropic" },
      { field: "model:a.providerModelId", before: "acme/a", after: "claude-a" },
      { field: "utilityModelId", before: "a", after: "c" },
    ]);

    expect(reprice.summary).toBe("repriced a: $8/M → $10/M");
    expect(reprice.changes).toEqual([
      { field: "model:a.pricing", before: "$8/M", after: "$10/M" },
    ]);
  });

  test("summarizes access, visibility and other edits", async () => {
    const t = asAdmin();
    await save(t, [model("a"), model("b")]);
    await save(t, [
      model("a", { name: "Alpha", vision: true }),
      model("b", { access: "promo_counted", hidden: true }),
    ]);
    const [row] = await auditRows(t);
    expect(row.summary).toBe("edited a (name, vision); access b: everyone → promo_counted; hid b");
    expect(row.changes?.map((c) => c.field)).toEqual([
      "model:a.name",
      "model:a.vision",
      "model:b.access",
      "model:b.hidden",
    ]);
  });
});

describe("platformCatalog reads", () => {
  test("getForUsers drops hidden models, routes and prices; null without a catalog", async () => {
    const base = setup();
    const user = base.withIdentity({ subject: "user_x" });
    expect(await user.query(api.platformCatalog.getForUsers, {})).toBeNull();

    await save(base.withIdentity(ADMIN), [
      model("a", { contextLength: 128_000 }),
      model("secret", { hidden: true }),
      model("opus", { access: "promo_counted" }),
    ]);
    expect(await user.query(api.platformCatalog.getForUsers, {})).toEqual({
      models: [
        { id: "a", name: "A", vendor: "acme", vision: false, contextLength: 128_000, access: "everyone" },
        { id: "opus", name: "OPUS", vendor: "acme", vision: false, access: "promo_counted" },
      ],
      defaultModelId: "a",
    });
  });

  test("getForUsers requires a signed-in user", async () => {
    expect(await codeOf(setup().query(api.platformCatalog.getForUsers, {}))).toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });

  test("getForServer returns routes and prices with the key and rejects a bad key", async () => {
    const t = asAdmin();
    const args = { internalKey: INTERNAL_KEY };
    expect(await t.query(api.platformCatalog.getForServer, args)).toBeNull();

    await save(t, [model("a"), model("b", { hidden: true })]);
    expect(await t.query(api.platformCatalog.getForServer, args)).toEqual({
      models: [model("a"), model("b", { hidden: true })],
      defaultModelId: "a",
      utilityModelId: "a",
    });
    expect(
      await codeOf(t.query(api.platformCatalog.getForServer, { internalKey: "nope" })),
    ).toMatchObject({ code: "UNAUTHENTICATED" });
  });
});

describe("platformCatalog.migrateFromProviderConfigs", () => {
  const legacy = (id: string, input: number, output: number) => ({
    id,
    name: id.toUpperCase(),
    vendor: "acme",
    vision: true,
    tools: "confirmed" as const,
    contextLength: 200_000,
    inputUsdPerMTok: input,
    outputUsdPerMTok: output,
  });

  test("copies the active provider's selection once, then is a no-op", async () => {
    const t = asAdmin();
    const migrate = () =>
      t.mutation(internal.platformCatalog.migrateFromProviderConfigs, {
        fallbackProvider: "openrouter",
      });
    expect(await migrate()).toBe("nothing to migrate");

    await t.run(async (ctx) => {
      const meta = { updatedAt: 1, updatedBy: ADMIN.subject };
      await ctx.db.insert("platformModelConfigs", {
        provider: "openrouter",
        models: [legacy("ignored", 1, 1)],
        defaultModelId: "ignored",
        ...meta,
      });
      await ctx.db.insert("platformModelConfigs", {
        provider: "groq",
        models: [legacy("split", 3, 15), legacy("flat", 2, 2)],
        defaultModelId: "flat",
        ...meta,
      });
      await ctx.db.insert("platformSettings", { activeProvider: "groq", ...meta });
    });

    expect(await migrate()).toBe("migrated 2 groq models (+0 promo), default flat");
    const { contextLength, vision, tools } = legacy("x", 0, 0);
    const route = { provider: "groq" as const, access: "everyone" as const, hidden: false };
    expect(await t.query(api.platformCatalog.getForAdmin, {})).toMatchObject({
      models: [
        {
          id: "split",
          name: "SPLIT",
          vendor: "acme",
          providerModelId: "split",
          contextLength,
          vision,
          tools,
          pricing: { mode: "split", inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
          ...route,
        },
        {
          id: "flat",
          providerModelId: "flat",
          pricing: { mode: "blended", usdPerMTok: 2 },
          ...route,
        },
      ],
      defaultModelId: "flat",
      utilityModelId: "flat",
      updatedBy: "system:migration",
    });
    const [row] = await auditRows(t);
    expect(row).toMatchObject({
      actorId: "system:migration",
      action: "platformCatalog.migrate",
      summary: "migrated 2 groq models (+0 promo), default flat",
    });
    expect(row.changes?.map((c) => c.field)).toEqual([
      "model:split",
      "model:flat",
      "defaultModelId",
      "utilityModelId",
    ]);

    expect(await migrate()).toBe("already migrated");
    expect(await auditRows(t)).toHaveLength(1);
  });

  test("keeps the provider's title model as the utility model, text-only on Anthropic", async () => {
    const t = asAdmin();
    await t.run(async (ctx) => {
      await ctx.db.insert("platformModelConfigs", {
        provider: "anthropic",
        models: [legacy("claude-sonnet-4-5", 3, 15), legacy("claude-haiku-4-5", 1, 5)],
        defaultModelId: "claude-sonnet-4-5",
        updatedAt: 1,
        updatedBy: ADMIN.subject,
      });
    });

    await t.mutation(internal.platformCatalog.migrateFromProviderConfigs, {
      fallbackProvider: "anthropic",
    });
    const catalog = await t.query(api.platformCatalog.getForAdmin, {});
    expect(catalog?.utilityModelId).toBe("claude-haiku-4-5");
    expect(catalog?.models.some((m) => m.vision)).toBe(false);
  });

  test("seeds promo models only into the room a full selection leaves", async () => {
    const t = asAdmin();
    const full = Array.from({ length: MAX_PLATFORM_MODELS }, (_, i) => legacy(`m${i}`, 1, 1));
    await t.run(async (ctx) => {
      await ctx.db.insert("platformModelConfigs", {
        provider: "openrouter",
        models: full,
        defaultModelId: "m0",
        updatedAt: 1,
        updatedBy: ADMIN.subject,
      });
    });

    expect(
      await t.mutation(internal.platformCatalog.migrateFromProviderConfigs, {
        fallbackProvider: "openrouter",
      }),
    ).toBe(`migrated ${MAX_PLATFORM_MODELS} openrouter models (+0 promo), default m0`);
  });

  test("seeds the GitHub promo's models on a Claude provider, keeping listed ones", async () => {
    const t = asAdmin();
    await t.run(async (ctx) => {
      await ctx.db.insert("platformModelConfigs", {
        provider: "openrouter",
        models: [legacy("cheap", 1, 1), legacy("anthropic/claude-sonnet-5.5", 2, 10)],
        defaultModelId: "cheap",
        updatedAt: 1,
        updatedBy: ADMIN.subject,
      });
    });

    expect(
      await t.mutation(internal.platformCatalog.migrateFromProviderConfigs, {
        fallbackProvider: "openrouter",
      }),
    ).toBe("migrated 2 openrouter models (+1 promo), default cheap");
    const models = (await t.query(api.platformCatalog.getForAdmin, {}))?.models ?? [];
    // Sonnet was already offered to everyone, so it stays that way.
    expect(models.map((m) => [m.id, m.access])).toEqual([
      ["cheap", "everyone"],
      ["anthropic/claude-sonnet-5.5", "everyone"],
      ["anthropic/claude-opus-5.5", "promo_counted"],
    ]);
  });
});
