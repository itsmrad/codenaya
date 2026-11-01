import { v } from "convex/values";

import {
  MAX_MODEL_NAME_LENGTH,
  MAX_MODEL_VENDOR_LENGTH,
  MAX_PLATFORM_MODELS,
  MAX_USD_PER_MTOK,
  riskyPriceModelIds,
} from "../src/features/admin/platform-models";
import type { CatalogModel, ModelPricing } from "../src/features/ai-providers/catalog";
import { AI_PROVIDERS, MAX_MODEL_ID_LENGTH } from "../src/features/ai-providers/registry";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, mutation, query, type QueryCtx } from "./_generated/server";
import { type Admin, type AuditChange, requireAdmin, writeAudit } from "./admin";
import { verifyAuth } from "./auth";
import { appError } from "./errors";
import { validateInternalKey } from "./internalKey";
import { catalogModelValidator, platformProviderValidator } from "./schema";

/**
 * The platform model catalog (ADR 0010). Users read ids, names and flags;
 * routes and prices stay with the admin and the server. Writes come only from
 * `POST /api/admin/catalog`, which checks step-up auth and the provider keys
 * (only Next sees them), so `save` needs the admin's token and the internal key.
 */

const publicCatalogModelValidator = catalogModelValidator.pick(
  "id",
  "name",
  "vendor",
  "vision",
  "contextLength",
  "access",
);

const catalogFields = {
  models: v.array(catalogModelValidator),
  defaultModelId: v.string(),
  utilityModelId: v.string(),
};

type Catalog = Pick<Doc<"platformCatalog">, "models" | "defaultModelId" | "utilityModelId">;

/** The single catalog doc; there is at most one. */
const getCatalog = (ctx: QueryCtx) => ctx.db.query("platformCatalog").first();

const invalid = (message: string) => appError("INVALID_ARGUMENT", message);

const isPrice = (n: number) => Number.isFinite(n) && n >= 0 && n <= MAX_USD_PER_MTOK;

const pricesOf = (pricing: ModelPricing) =>
  pricing.mode === "blended"
    ? [pricing.usdPerMTok]
    : [pricing.inputUsdPerMTok, pricing.outputUsdPerMTok];

const isModelId = (id: string) => !!id && id.length <= MAX_MODEL_ID_LENGTH;

function assertValidCatalog({ models, defaultModelId, utilityModelId }: Catalog) {
  if (models.length === 0 || models.length > MAX_PLATFORM_MODELS) {
    throw invalid(`Select between 1 and ${MAX_PLATFORM_MODELS} models`);
  }
  const byId = new Map<string, CatalogModel>();
  for (const model of models) {
    if (!isModelId(model.id)) throw invalid("Invalid model id");
    if (byId.has(model.id)) throw invalid(`Duplicate model ${model.id}`);
    byId.set(model.id, model);
    if (!isModelId(model.providerModelId)) throw invalid(`Invalid provider model id for ${model.id}`);
    if (!model.name.trim() || model.name.length > MAX_MODEL_NAME_LENGTH) {
      throw invalid(`Invalid name for ${model.id}`);
    }
    if (model.vendor.length > MAX_MODEL_VENDOR_LENGTH) throw invalid(`Invalid vendor for ${model.id}`);
    if (
      model.contextLength !== undefined &&
      !(Number.isInteger(model.contextLength) && model.contextLength > 0)
    ) {
      throw invalid(`Invalid context length for ${model.id}`);
    }
    if (!pricesOf(model.pricing).every(isPrice)) {
      throw invalid(`Prices for ${model.id} must be between $0 and $${MAX_USD_PER_MTOK} per 1M tokens`);
    }
    // AgentKit's Anthropic adapter is text-only, so images would never reach it.
    if (model.provider === "anthropic" && model.vision) {
      throw invalid(`${model.id} can't accept images on the Anthropic route`);
    }
  }
  // Every user's runs may land on these, so they must be open to everyone. The
  // utility model may be hidden: a cheap model for titles that users don't pick.
  for (const [role, id] of [
    ["default", defaultModelId],
    ["utility", utilityModelId],
  ] as const) {
    const model = byId.get(id);
    if (!model || (role === "default" && model.hidden)) {
      throw invalid(`The ${role} model must be a ${role === "default" ? "visible " : ""}catalog model`);
    }
    if (model.access !== "everyone") throw invalid(`The ${role} model must be open to everyone`);
  }
}

/** "$8/M", or "$4/$20 per M" for split prices. */
const priceLabel = (pricing: ModelPricing) =>
  pricing.mode === "blended"
    ? `$${pricing.usdPerMTok}/M`
    : `$${pricing.inputUsdPerMTok}/$${pricing.outputUsdPerMTok} per M`;

const route = (model: CatalogModel) => `${model.provider}:${model.providerModelId}`;

/** The audited fields of a model, each as a short string. */
const MODEL_FIELDS = [
  "provider",
  "providerModelId",
  "pricing",
  "access",
  "hidden",
  "name",
  "vendor",
  "contextLength",
  "vision",
  "tools",
] as const;
const ROUTE_FIELDS: readonly string[] = ["provider", "providerModelId"];
const SUMMARIZED_FIELDS: readonly string[] = [...ROUTE_FIELDS, "pricing", "access", "hidden"];

const fieldValue = (model: CatalogModel, field: (typeof MODEL_FIELDS)[number]) => {
  if (field === "pricing") return priceLabel(model.pricing);
  return model[field] === undefined ? undefined : String(model[field]);
};

/**
 * The structured audit changes from `before` to `after` (one per changed field
 * per model, plus the default and utility model) and a one-line summary:
 * "added a ($8/M on openrouter); removed b; re-routed c: x → y; …".
 */
function diffCatalog(before: Catalog | null, after: Catalog) {
  const changes: AuditChange[] = [];
  const parts: string[] = [];
  const old = new Map((before?.models ?? []).map((m) => [m.id, m]));
  const now = new Set(after.models.map((m) => m.id));

  const added = after.models.filter((m) => !old.has(m.id));
  for (const m of added) changes.push({ field: `model:${m.id}`, after: JSON.stringify(m) });
  if (added.length) {
    parts.push(`added ${added.map((m) => `${m.id} (${priceLabel(m.pricing)} on ${m.provider})`).join(", ")}`);
  }
  const removed = [...old.values()].filter((m) => !now.has(m.id));
  for (const m of removed) changes.push({ field: `model:${m.id}`, before: JSON.stringify(m) });
  if (removed.length) parts.push(`removed ${removed.map((m) => m.id).join(", ")}`);

  for (const m of after.models) {
    const was = old.get(m.id);
    if (!was) continue;
    const changed = MODEL_FIELDS.filter((f) => fieldValue(was, f) !== fieldValue(m, f));
    for (const f of changed) {
      changes.push({ field: `model:${m.id}.${f}`, before: fieldValue(was, f), after: fieldValue(m, f) });
    }
    if (changed.some((f) => ROUTE_FIELDS.includes(f))) {
      parts.push(`re-routed ${m.id}: ${route(was)} → ${route(m)}`);
    }
    if (changed.includes("pricing")) {
      parts.push(`repriced ${m.id}: ${priceLabel(was.pricing)} → ${priceLabel(m.pricing)}`);
    }
    if (changed.includes("access")) parts.push(`access ${m.id}: ${was.access} → ${m.access}`);
    if (changed.includes("hidden")) parts.push(`${m.hidden ? "hid" : "showed"} ${m.id}`);
    const edited = changed.filter((f) => !SUMMARIZED_FIELDS.includes(f));
    if (edited.length) parts.push(`edited ${m.id} (${edited.join(", ")})`);
  }

  for (const [field, label] of [
    ["defaultModelId", "default"],
    ["utilityModelId", "utility"],
  ] as const) {
    if (before?.[field] !== after[field]) {
      changes.push({ field, before: before?.[field], after: after[field] });
      parts.push(`${label} → ${after[field]}`);
    }
  }
  return { changes, summary: parts.join("; ") || "no changes" };
}

/**
 * The catalog for users' pickers, hidden models left out, without routes or
 * prices. Null: no catalog saved, use the env provider's curated catalog.
 */
export const getForUsers = query({
  args: {},
  returns: v.union(
    v.object({ models: v.array(publicCatalogModelValidator), defaultModelId: v.string() }),
    v.null(),
  ),
  handler: async (ctx) => {
    await verifyAuth(ctx);
    const catalog = await getCatalog(ctx);
    return (
      catalog && {
        models: catalog.models
          .filter((m) => !m.hidden)
          .map(({ id, name, vendor, vision, contextLength, access }) => ({
            id,
            name,
            vendor,
            vision,
            contextLength,
            access,
          })),
        defaultModelId: catalog.defaultModelId,
      }
    );
  },
});

/** The full catalog for routes and agent runs: one read on the send path. */
export const getForServer = query({
  args: { internalKey: v.string() },
  returns: v.union(v.object(catalogFields), v.null()),
  handler: async (ctx, { internalKey }) => {
    validateInternalKey(internalKey);
    const catalog = await getCatalog(ctx);
    return (
      catalog && {
        models: catalog.models,
        defaultModelId: catalog.defaultModelId,
        utilityModelId: catalog.utilityModelId,
      }
    );
  },
});

/** The full catalog for the /admin editor. */
export const getForAdmin = query({
  args: {},
  returns: v.union(
    v.object({ ...catalogFields, updatedAt: v.number(), updatedBy: v.string() }),
    v.null(),
  ),
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const catalog = await getCatalog(ctx);
    return (
      catalog && {
        models: catalog.models,
        defaultModelId: catalog.defaultModelId,
        utilityModelId: catalog.utilityModelId,
        updatedAt: catalog.updatedAt,
        updatedBy: catalog.updatedBy,
      }
    );
  },
});

/**
 * Replaces the catalog. Admin token AND internal key: the route has already
 * checked step-up auth and that every route's provider key is set. A $0 price
 * or a price change over 50% is refused unless `confirmRiskyPrices`. Writes a
 * structured audit row in the same transaction.
 */
export const save = mutation({
  args: {
    internalKey: v.string(),
    ...catalogFields,
    confirmRiskyPrices: v.boolean(),
    request: v.object({
      requestId: v.string(),
      ip: v.optional(v.string()),
      userAgent: v.optional(v.string()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, { internalKey, confirmRiskyPrices, request, ...catalog }) => {
    const admin = await requireAdmin(ctx);
    validateInternalKey(internalKey);
    assertValidCatalog(catalog);

    const existing = await getCatalog(ctx);
    const risky = confirmRiskyPrices ? [] : riskyPriceModelIds(existing?.models ?? [], catalog.models);
    if (risky.length) {
      throw appError(
        "CONFLICT",
        `Confirm the prices of ${risky.join(", ")}: $0, or changed by more than 50%`,
        { reason: "risky_price" },
      );
    }

    const fields = { ...catalog, updatedAt: Date.now(), updatedBy: admin.id };
    if (existing) {
      await ctx.db.replace("platformCatalog", existing._id, fields);
    } else {
      await ctx.db.insert("platformCatalog", fields);
    }

    const { changes, summary } = diffCatalog(existing, catalog);
    await writeAudit(ctx, admin, "platformCatalog.save", summary, { changes, ...request });
    return null;
  },
});

/** The actor of the one-off migration's audit row. */
const MIGRATION_ACTOR: Admin = { id: "system:migration", email: "system:migration" };

/**
 * The GitHub promo's models (ADR 0009), which the old setup added for claimants
 * on top of the selection: the migration seeds them so claimants keep them.
 * Prices are OpenRouter's at migration time; the admin can re-route them (e.g.
 * to the Anthropic key) and reprice in /admin.
 */
const PROMO_SEEDS: Partial<Record<CatalogModel["provider"], CatalogModel[]>> = {
  openrouter: [
    {
      id: "anthropic/claude-opus-5.5",
      name: "Claude Opus 5.5",
      vendor: "Anthropic",
      provider: "openrouter",
      providerModelId: "anthropic/claude-opus-5.5",
      vision: true,
      tools: "reported",
      pricing: { mode: "split", inputUsdPerMTok: 4, outputUsdPerMTok: 20 },
      access: "promo_counted",
      hidden: false,
    },
    {
      id: "anthropic/claude-sonnet-5.5",
      name: "Claude Sonnet 5.5",
      vendor: "Anthropic",
      provider: "openrouter",
      providerModelId: "anthropic/claude-sonnet-5.5",
      vision: true,
      tools: "reported",
      pricing: { mode: "split", inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
      access: "promo_unlimited",
      hidden: false,
    },
  ],
  anthropic: [
    {
      id: "claude-opus-5-5",
      name: "Claude Opus 5.5",
      vendor: "Anthropic",
      provider: "anthropic",
      providerModelId: "claude-opus-5-5",
      vision: false,
      tools: "reported",
      pricing: { mode: "split", inputUsdPerMTok: 4, outputUsdPerMTok: 20 },
      access: "promo_counted",
      hidden: false,
    },
    {
      id: "claude-sonnet-5-5",
      name: "Claude Sonnet 5.5",
      vendor: "Anthropic",
      provider: "anthropic",
      providerModelId: "claude-sonnet-5-5",
      vision: false,
      tools: "reported",
      pricing: { mode: "split", inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
      access: "promo_unlimited",
      hidden: false,
    },
  ],
};

/**
 * One-off: builds the catalog from the deprecated per-provider config of the
 * active provider (`platformSettings`, else `fallbackProvider`). No-op when a
 * catalog exists. Run with `npx convex run platformCatalog:migrateFromProviderConfigs`.
 */
export const migrateFromProviderConfigs = internalMutation({
  args: {
    fallbackProvider: platformProviderValidator,
  },
  returns: v.string(),
  handler: async (ctx, { fallbackProvider }) => {
    if (await getCatalog(ctx)) return "already migrated";
    const provider =
      (await ctx.db.query("platformSettings").first())?.activeProvider ?? fallbackProvider;
    const config = await ctx.db
      .query("platformModelConfigs")
      .withIndex("by_provider", (q) => q.eq("provider", provider))
      .unique();
    if (!config) return "nothing to migrate";

    const migrated = config.models.map(({ inputUsdPerMTok, outputUsdPerMTok, ...model }) => ({
      ...model,
      // Same rule `save` enforces: the Anthropic route is text-only.
      vision: model.vision && provider !== "anthropic",
      provider,
      providerModelId: model.id,
      pricing:
        inputUsdPerMTok === outputUsdPerMTok
          ? { mode: "blended" as const, usdPerMTok: inputUsdPerMTok }
          : { mode: "split" as const, inputUsdPerMTok, outputUsdPerMTok },
      access: "everyone" as const,
      hidden: false,
    }));
    // A promo model the selection already offered everyone stays as it was.
    const listed = new Set(migrated.map((m) => m.id));
    // Only into the room left, so the catalog stays one `save` accepts.
    const promo = (PROMO_SEEDS[provider] ?? [])
      .filter((m) => !listed.has(m.id))
      .slice(0, Math.max(0, MAX_PLATFORM_MODELS - migrated.length));
    // Titles ran on the provider's `titleModel`; keep it when the selection had it.
    const titleModelId = AI_PROVIDERS[provider].titleModel;
    const catalog: Catalog = {
      models: [...migrated, ...promo],
      defaultModelId: config.defaultModelId,
      utilityModelId: migrated.some((m) => m.id === titleModelId) ? titleModelId! : config.defaultModelId,
    };
    await ctx.db.insert("platformCatalog", {
      ...catalog,
      updatedAt: Date.now(),
      updatedBy: MIGRATION_ACTOR.id,
    });

    const { changes } = diffCatalog(null, catalog);
    const summary =
      `migrated ${migrated.length} ${provider} models (+${promo.length} promo), ` +
      `default ${catalog.defaultModelId}`;
    await writeAudit(ctx, MIGRATION_ACTOR, "platformCatalog.migrate", summary, { changes });
    return summary;
  },
});
