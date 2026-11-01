import { NextResponse } from "next/server";
import { z } from "zod";

import { convex } from "@/lib/convex-client";
import {
  CREDIT_REFUSAL_MESSAGES,
  INSUFFICIENT_CREDITS_CODE,
  type RunSource,
  creditRefusal,
} from "@/features/billing/credits";
import { PLANS } from "@/features/billing/plans";
import type { AgentModelChoice } from "@/features/conversations/agent-models";

import {
  PROMO_REFUSAL_MESSAGES,
  type PromoModelKind,
  type PromoRunRefusal,
  promoRunRefusal,
} from "@/features/promotions/github-promo";

import { type ModelPricing, promoKindOf } from "../catalog";
import {
  type PlatformProviderId,
  type RoutedModel,
  resolveCatalogModel,
  utilityModel,
} from "../platform";
import {
  modelAcceptsImages,
  modelIdsFor,
  runModelLabel,
  titleModelFor,
} from "../registry";
import { buildAgentKitModel } from "./agentkit-model";
import { assertSafeProviderBaseUrl } from "./base-url";
import {
  AI_NOT_CONFIGURED_MESSAGE,
  isPlatformConfigured,
  platformAgentModel,
  platformCatalog,
} from "./platform-model";
import { openProviderKey } from "./sealed-key";
import { OUT_OF_CREDIT_PATTERN, isOutOfCredit, testConnection } from "./test-connection";
import { api } from "../../../../convex/_generated/api";
import type { Doc, Id } from "../../../../convex/_generated/dataModel";

/**
 * Which model and key an agent run uses.
 *
 * Two checkpoints, same rules: `validateModelChoice` in the API route (so a bad
 * choice fails the request before anything is created) and `resolveRunModel` in
 * the Inngest function (the event is the boundary it trusts, and anything
 * holding the event key can send one).
 *
 * ## The decrypted key never becomes a step result
 *
 * Inngest persists every `step.run` return value. `resolveRunModel` is called in
 * the function body, outside any step, and hands back AgentKit models whose key
 * lives only in memory — the same rule as MCP `resolve-servers`. Re-resolving on
 * each replay is the price; it is one Convex read and one unwrap.
 *
 * ## No fallback to the platform key
 *
 * A missing, invalid or rejected user key fails the run with a message pointing
 * to the settings page. Silently switching to Codenaya's key would surprise the
 * user with credit spend and a different provider.
 */

export const AI_PROVIDERS_SETTINGS_PATH = "/settings/ai-providers";

/**
 * The `model` field of a send request. Checked by `validateModelChoice` rather
 * than here: an unknown platform id falls back to the default, a BYOK choice
 * must be the caller's key and one of its models. A bare string is a platform
 * model id from a client predating BYOK.
 */
export const modelChoiceSchema = z
  .union([
    z.string(),
    z.object({ keyId: z.string().optional(), modelId: z.string() }),
  ])
  .optional();

export type ModelChoiceInput = z.infer<typeof modelChoiceSchema>;

/** A validated choice, recorded on the assistant message and sent on the event. */
export interface RunModelChoice {
  keyId?: Id<"aiProviderKeys">;
  modelId: string;
  label: string;
  /** Platform runs: the provider whose key serves the model's route. */
  provider?: PlatformProviderId;
}

/**
 * A choice the route refuses: someone else's key (403), a model it lacks
 * (400), or platform AI without a key (503, `code: "ai_not_configured"`).
 */
export class ModelChoiceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 402 | 403 | 503,
    readonly code?: string,
  ) {
    super(message);
  }
}

const toChoice = (input: ModelChoiceInput): AgentModelChoice =>
  typeof input === "object" ? input : { modelId: input ?? "" };

/** The message has images and the model cannot read them. */
const visionRequired = (label: string) =>
  new ModelChoiceError(
    `${label} can't read images. Pick a vision model to send them.`,
    400,
  );

/** Platform models are labelled as the platform's, whichever provider serves them. */
const platformRunLabel = (model: RoutedModel) => runModelLabel({ id: model.id, label: model.name });

/**
 * Route-side check. Platform ids the catalog doesn't offer (unknown or hidden)
 * fall back to its default, and a model whose route's provider has no key is
 * refused, never re-routed; a BYOK choice must name a key the caller owns and
 * a model that key's provider offers. With `withImages`, the model must accept
 * images.
 *
 * A promo model (ADR 0009) needs the caller's claim with a run left. The check
 * changes nothing; `promoKind` tells `takePromoRun` which run to take once the
 * send is known to go. Any other platform model needs credits left (ADR 0011);
 * a run that starts with some may end past zero, and the next send is refused.
 */
export async function validateModelChoice({
  internalKey,
  userId,
  model,
  withImages = false,
}: {
  internalKey: string;
  userId: string;
  model: ModelChoiceInput;
  withImages?: boolean;
}): Promise<RunModelChoice & { promoKind?: PromoModelKind }> {
  const { keyId, modelId } = toChoice(model);
  if (!keyId) {
    const [catalog, account] = await Promise.all([
      platformCatalog(internalKey),
      convex.query(api.credits.getForServer, { internalKey, userId }),
    ]);
    const model = resolveCatalogModel(catalog, modelId);
    if (!isPlatformConfigured(model.provider)) {
      throw new ModelChoiceError(AI_NOT_CONFIGURED_MESSAGE, 503, "ai_not_configured");
    }
    const choice = { modelId: model.id, label: platformRunLabel(model), provider: model.provider };
    if (withImages && !model.vision) {
      throw visionRequired(choice.label);
    }
    const promoKind = promoKindOf(model.access);
    if (promoKind) {
      const claim = await convex.query(api.promoClaims.getForServer, { internalKey, userId });
      const refusal = claim ? promoRunRefusal(claim, { kind: promoKind }, Date.now()) : "not_claimed";
      if (refusal) {
        throw promoRefused(refusal);
      }
      return { ...choice, promoKind };
    }
    // Usage is always recorded; the cap only applies once billing is live (#105).
    const refusal =
      process.env.CREDIT_LIMITS_ENFORCED === "true" &&
      creditRefusal(PLANS[account?.plan ?? "free"], account, Date.now());
    if (refusal) {
      throw new ModelChoiceError(CREDIT_REFUSAL_MESSAGES[refusal], 402, INSUFFICIENT_CREDITS_CODE);
    }
    return choice;
  }

  // A malformed id fails Convex argument validation: same answer as a foreign one.
  const key = await convex
    .query(api.system.getAiProviderKeyForUser, {
      internalKey,
      keyId: keyId as Id<"aiProviderKeys">,
      userId,
    })
    .catch(() => null);

  if (!key) {
    throw new ModelChoiceError("AI provider key not found", 403);
  }
  if (!modelIdsFor(key).includes(modelId)) {
    throw new ModelChoiceError("Model is not available for this key", 400);
  }

  const label = runModelLabel(modelId, key);
  if (withImages && !modelAcceptsImages(modelId, key)) {
    throw visionRequired(label);
  }

  return { keyId: key._id, modelId, label };
}

/**
 * `validateModelChoice` for route handlers: a refused choice comes back as the
 * JSON error response to return. `runModel` is what the message records;
 * `promoKind` goes to `takePromoRun`.
 *
 *   const { runModel, promoKind, rejected } = await requireModelChoice({ ... });
 *   if (rejected) return rejected;
 */
export async function requireModelChoice(
  args: Parameters<typeof validateModelChoice>[0],
): Promise<
  | { runModel: RunModelChoice; promoKind?: PromoModelKind; rejected?: undefined }
  | { runModel?: undefined; promoKind?: undefined; rejected: NextResponse }
> {
  try {
    const { promoKind, ...runModel } = await validateModelChoice(args);
    return { runModel, promoKind };
  } catch (error) {
    if (error instanceof ModelChoiceError) {
      return { rejected: modelChoiceErrorResponse(error) };
    }
    throw error;
  }
}

const modelChoiceErrorResponse = (error: ModelChoiceError) =>
  NextResponse.json(
    { error: error.message, ...(error.code ? { code: error.code } : {}) },
    { status: error.status },
  );

const promoRefused = (refusal: PromoRunRefusal | "not_claimed") =>
  new ModelChoiceError(PROMO_REFUSAL_MESSAGES[refusal], 403, `promo_${refusal}`);

/**
 * A promo run a send took. `refund` gives it back when the send fails before
 * its agent run starts; it never throws, so it can't replace the route's own
 * error response (a failed refund is logged and the run stays used).
 */
export interface PromoRun {
  refund: () => Promise<void>;
}

const NO_PROMO_RUN: PromoRun = { refund: async () => {} };

/**
 * Takes the promo run (ADR 0009) a validated choice needs, in one Convex
 * transaction, so two sends racing for the last Opus run can't both pass.
 * Call it after the route's ownership checks and before it creates anything;
 * without a `promoKind` it takes nothing. A refusal comes back as the
 * response to return.
 *
 *   const { promoRun, rejected } = await takePromoRun({ internalKey, userId, promoKind });
 *   if (rejected) return rejected;
 *   try { ...create and dispatch; on a failed dispatch, await promoRun.refund()... }
 *   catch (error) { await promoRun.refund(); throw error; }
 */
export async function takePromoRun({
  internalKey,
  userId,
  promoKind,
}: {
  internalKey: string;
  userId: string;
  promoKind: PromoModelKind | undefined;
}): Promise<
  | { promoRun: PromoRun; rejected?: undefined }
  | { promoRun?: undefined; rejected: NextResponse }
> {
  if (!promoKind) {
    return { promoRun: NO_PROMO_RUN };
  }

  const args = { internalKey, userId, kind: promoKind };
  const refusal = await convex.mutation(api.promoClaims.takeRun, args);
  if (refusal) {
    return { rejected: modelChoiceErrorResponse(promoRefused(refusal)) };
  }
  return {
    promoRun: {
      refund: async () => {
        await convex.mutation(api.promoClaims.refundRun, args).catch((error: unknown) => {
          console.error("[promo] couldn't refund a promo run", error);
        });
      },
    },
  };
}

/** A run's key could not be used. `message` is written as the assistant reply. */
export class ProviderKeyError extends Error {}

export const keyFailureMessage = (reason: string) =>
  `${reason} Update it in [Settings → AI providers](${AI_PROVIDERS_SETTINGS_PATH}) and try again. ` +
  "Your request was not sent to Codenaya's models.";

type AgentKitModel = ReturnType<typeof buildAgentKitModel>;

export interface RunModel {
  /** Set for runs on the user's own key. Holds no key material. */
  key?: Pick<Doc<"aiProviderKeys">, "_id" | "userId" | "label">;
  /** The coding agent's model. */
  coding: (temperature?: number) => AgentKitModel;
  /** The conversation title model, on the same provider. */
  title: (temperature?: number) => AgentKitModel;
  /**
   * BYOK only: whether the provider still accepts the key (the free
   * test-connection call) and the account can still pay for inference
   * (`isOutOfCredit`). Inngest retries a failed inference with backoff before
   * the run sees the error, so checking first is what lets a revoked or
   * out-of-credit key fail in seconds. Returns no key material, so it is safe
   * as a step.
   */
  checkKey?: () => Promise<{ rejected: boolean }>;
  /**
   * Who pays (ADR 0011), and the catalog prices the run's usage is charged
   * at. No price (the env catalog, BYOK) records tokens at $0.
   */
  metering: { source: RunSource; coding?: ModelPricing; title?: ModelPricing };
}

/**
 * Run-side resolution. Throws `ProviderKeyError` when the platform has no key,
 * or when the user's key is gone, not owned by the project's owner, marked
 * invalid, no longer offers the model, or its custom endpoint no longer passes
 * the SSRF guard.
 * Call it in the function body, never inside `step.run`.
 */
export async function resolveRunModel({
  internalKey,
  projectId,
  choice,
}: {
  internalKey: string;
  projectId: Id<"projects">;
  choice: AgentModelChoice;
}): Promise<RunModel> {
  if (!choice.keyId) {
    // Re-read, not taken from the event: the admin may have re-routed, hidden
    // or removed the model since the route checked it.
    const catalog = await platformCatalog(internalKey);
    const model = resolveCatalogModel(catalog, choice.modelId);
    // The key can go missing between the route's check and the run (a redeploy).
    if (!isPlatformConfigured(model.provider)) {
      throw new ProviderKeyError(AI_NOT_CONFIGURED_MESSAGE);
    }
    // The send took the run and checked the end date; the run re-checks only
    // the claim, so a run queued just before the end still goes ahead.
    if (
      promoKindOf(model.access) &&
      !(await convex.query(api.promoClaims.hasClaimForProjectOwner, { internalKey, projectId }))
    ) {
      throw new ProviderKeyError(PROMO_REFUSAL_MESSAGES.not_claimed);
    }
    // A title is no reason to fail the run: without the utility route's key
    // it is written by the run's own model.
    const utility = utilityModel(catalog);
    const title = isPlatformConfigured(utility.provider) ? utility : model;
    return {
      coding: (temperature) => platformAgentModel(model.provider, model.providerModelId, temperature),
      title: (temperature) => platformAgentModel(title.provider, title.providerModelId, temperature),
      metering: {
        source: promoKindOf(model.access) ? "promo" : "platform",
        coding: model.pricing,
        title: title.pricing,
      },
    };
  }

  const key = await convex.query(api.system.getAiProviderKeyForRun, {
    internalKey,
    keyId: choice.keyId as Id<"aiProviderKeys">,
    projectId,
  });

  if (!key) {
    throw new ProviderKeyError(
      keyFailureMessage("The AI provider key selected for this chat no longer exists."),
    );
  }
  if (key.status === "invalid") {
    throw new ProviderKeyError(
      keyFailureMessage(`Your ${key.label} key was rejected by the provider.`),
    );
  }
  if (!modelIdsFor(key).includes(choice.modelId)) {
    throw new ProviderKeyError(
      keyFailureMessage(`Your ${key.label} key no longer offers ${choice.modelId}.`),
    );
  }

  // The base URL was checked when the key was saved, but its host can since
  // resolve somewhere private (DNS rebinding). AgentKit sends inference through
  // `step.ai.infer` or a plain `fetch`, neither of which takes our guarded fetch,
  // so re-check before every run instead.
  if (key.baseUrl) {
    const verdict = await assertSafeProviderBaseUrl(key.baseUrl);
    if (!verdict.ok) {
      throw new ProviderKeyError(
        keyFailureMessage(
          `The endpoint for your ${key.label} key is no longer allowed. ${verdict.reason.replace(/\.?$/, ".")}`,
        ),
      );
    }
  }

  const apiKey = await openProviderKey(key);
  const build = (model: string, temperature?: number) =>
    buildAgentKitModel({
      provider: key.provider,
      apiKey,
      baseUrl: key.baseUrl,
      model,
      temperature,
    });
  const titleModel = titleModelFor(key) ?? choice.modelId;

  return {
    key: { _id: key._id, userId: key.userId, label: key.label },
    coding: (temperature) => build(choice.modelId, temperature),
    title: (temperature) => build(titleModel, temperature),
    metering: { source: "byok" },
    // Only a definite refusal counts: an unreachable provider is left for the
    // inference itself to retry.
    checkKey: async () => {
      const credential = { provider: key.provider, apiKey, baseUrl: key.baseUrl };
      const result = await testConnection(credential);
      if (!result.ok) {
        return { rejected: result.kind === "unauthorized" };
      }
      return { rejected: await isOutOfCredit({ ...credential, model: choice.modelId }) };
    },
  };
}

/**
 * Provider wording for a refused key: unauthorized, forbidden, payment
 * required or out of quota. AgentKit rethrows only the error body's message,
 * so the status code is often gone by the time the run sees the error.
 */
const KEY_REJECTION_PATTERNS = [
  /\b(401|402|403)\b/,
  /unauthori[sz]ed|forbidden|payment required/i,
  /invalid[ _-]?(x-)?api[ _-]?key|incorrect api key|no auth credentials/i,
  /authentication[_ ]?error/i,
  OUT_OF_CREDIT_PATTERN,
];

/**
 * Whether a failed inference means the provider refused the key itself.
 * Plain rate limits and server errors are not the key's fault.
 */
export function isProviderKeyRejection(error: unknown): boolean {
  const text = errorText(error);
  return KEY_REJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

/** Message, status and cause chain of an error, flattened for matching. */
function errorText(error: unknown, depth = 0): string {
  if (depth > 4 || error == null) return "";
  if (typeof error !== "object") return String(error);
  const { message, status, cause, error: inner } = error as Record<string, unknown>;
  return [message, status, errorText(cause, depth + 1), errorText(inner, depth + 1)]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
}
