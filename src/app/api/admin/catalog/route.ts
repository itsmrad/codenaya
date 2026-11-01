import { fetchMutation } from "convex/nextjs";
import { NextResponse } from "next/server";
import { z } from "zod";

import {
  MAX_MODEL_NAME_LENGTH,
  MAX_MODEL_VENDOR_LENGTH,
  MAX_PLATFORM_MODELS,
  MAX_USD_PER_MTOK,
} from "@/features/admin/platform-models";
import { ADMIN_CATALOG_SAVE_RATE_LIMIT, requireAdminWrite } from "@/features/admin/server/admin-request";
import { PLATFORM_PROVIDER_IDS } from "@/features/ai-providers/platform";
import { AI_PROVIDERS, MAX_MODEL_ID_LENGTH } from "@/features/ai-providers/registry";
import { PLATFORM_KEY_ENV, platformKeyOrNull } from "@/features/ai-providers/server/platform-model";
import { getAppError } from "@/lib/convex-error";
import { parseJsonBody } from "@/lib/parse-json-body";

import { api } from "../../../../../convex/_generated/api";

const modelId = z.string().trim().min(1).max(MAX_MODEL_ID_LENGTH);
const price = z.number().finite().min(0).max(MAX_USD_PER_MTOK);

// Mirrors `catalogModelValidator` (convex/schema.ts); Convex checks again.
const modelSchema = z.object({
  id: modelId,
  name: z.string().trim().min(1).max(MAX_MODEL_NAME_LENGTH),
  vendor: z.string().trim().min(1).max(MAX_MODEL_VENDOR_LENGTH),
  provider: z.enum(PLATFORM_PROVIDER_IDS),
  providerModelId: modelId,
  contextLength: z.number().int().positive().optional(),
  vision: z.boolean(),
  tools: z.enum(["reported", "confirmed"]),
  pricing: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("blended"), usdPerMTok: price }),
    z.object({ mode: z.literal("split"), inputUsdPerMTok: price, outputUsdPerMTok: price }),
  ]),
  access: z.enum(["everyone", "promo_counted", "promo_unlimited"]),
  hidden: z.boolean(),
});

const requestSchema = z
  .object({
    models: z.array(modelSchema).min(1).max(MAX_PLATFORM_MODELS),
    defaultModelId: modelId,
    utilityModelId: modelId,
    confirmRiskyPrices: z.boolean(),
  })
  .superRefine(({ models, defaultModelId, utilityModelId }, ctx) => {
    const byId = new Map(models.map((m) => [m.id, m]));
    if (byId.size !== models.length) ctx.addIssue({ code: "custom", path: ["models"], message: "Duplicate model id" });
    const defaultModel = byId.get(defaultModelId);
    if (!defaultModel || defaultModel.hidden || defaultModel.access !== "everyone") {
      ctx.addIssue({ code: "custom", path: ["defaultModelId"], message: "Must be a visible model everyone can use" });
    }
    if (byId.get(utilityModelId)?.access !== "everyone") {
      ctx.addIssue({ code: "custom", path: ["utilityModelId"], message: "Must be a model everyone can use" });
    }
  });

/**
 * POST /api/admin/catalog: replaces the platform model catalog (ADR 0010).
 * Only this server can see which provider keys are set, so it refuses a route
 * without one here, then calls Convex as the admin (their token, for authz and
 * the audit row) plus the internal key that proves these checks ran.
 */
export async function POST(request: Request) {
  const { admin, meta, denied } = await requireAdminWrite(request, ADMIN_CATALOG_SAVE_RATE_LIMIT);
  if (denied) return denied;

  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;
  if (!internalKey) {
    return NextResponse.json({ error: "Internal key not configured" }, { status: 500 });
  }

  const { data, invalid } = await parseJsonBody(request, requestSchema);
  if (invalid) return invalid;

  const keyless = [...new Set(data.models.map((m) => m.provider))].find((p) => !platformKeyOrNull(p));
  if (keyless) {
    // The variable name stays in the server log.
    console.error(`[admin-catalog] ${PLATFORM_KEY_ENV[keyless]} is not set; refused a catalog routing to ${keyless}.`);
    return NextResponse.json(
      {
        error: `${AI_PROVIDERS[keyless].label} has no platform key, so models can't be routed to it`,
        code: "key_missing",
        provider: keyless,
      },
      { status: 409 },
    );
  }

  try {
    await fetchMutation(api.platformCatalog.save, { internalKey, ...data, request: meta }, { token: admin.token });
  } catch (error) {
    const appError = getAppError(error);
    switch (appError?.code) {
      // Admin rights lost between the check above and the mutation: same 404.
      case "NOT_FOUND":
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      case "INVALID_ARGUMENT":
        return NextResponse.json({ error: appError.message, code: "invalid_catalog" }, { status: 400 });
      case "CONFLICT":
        return NextResponse.json(
          { error: appError.message, code: appError.reason === "risky_price" ? "risky_price" : "conflict" },
          { status: 409 },
        );
      default:
        throw error;
    }
  }
  return NextResponse.json({ ok: true });
}
