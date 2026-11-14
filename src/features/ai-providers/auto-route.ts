import { buildPlanMessage } from "../conversations/plan-mode";
import { type ModelPricing, type PublicCatalogModel, blendedUsdPerMTok, pickableModels } from "./catalog";

/**
 * The opt-in "Auto" platform model (#322): each send runs on a model picked for
 * its task, from the admin's Auto pool or else a fixed map, and only among the
 * catalog models users may pick.
 * The send route resolves it to a concrete model id (`validateModelChoice`), so
 * the run, its metering and the promo/credit gates only ever see a real model.
 * Pure and client-safe: the picker lists the entry, the server routes with it.
 */

export const AUTO_MODEL_ID = "auto";

/** The picker entry, listed first among the platform's models. */
export const AUTO_MODEL: PublicCatalogModel = {
  id: AUTO_MODEL_ID,
  name: "Auto",
  vendor: "Picks per task",
  // Image sends route to a vision model.
  vision: true,
  access: "everyone",
};

export type RunTask = "plan" | "build" | "edit" | "fix" | "vision";

/** A follow-up shorter than this, in an existing project, is a small edit. */
export const EDIT_MAX_CHARS = 400;

/**
 * The task of a send, deterministic and in precedence order: plan mode, then
 * images, then an explicit fix request, then a project's first build (no
 * finished build yet) or an accepted plan ("Build this plan"), then short
 * (edit) vs long (build) follow-ups.
 */
export function classifyRun({
  planMode,
  hasImages,
  source,
  firstBuild,
  message,
}: {
  planMode: boolean;
  hasImages: boolean;
  /** "fix" from "Fix with AI" (#223) or a loop-breaker retry (#306). */
  source?: "fix";
  /** The project has no finished build yet (`conversationNeedsFirstBuildForServer`). */
  firstBuild: boolean;
  message: string;
}): RunTask {
  if (planMode) return "plan";
  if (hasImages) return "vision";
  if (source === "fix") return "fix";
  if (firstBuild || message.startsWith(buildPlanMessage(""))) return "build";
  return message.length < EDIT_MAX_CHARS ? "edit" : "build";
}

/**
 * Catalog ids per task, best first; the rest are fallbacks for when the admin
 * hid, removed, re-priced as promo or left unconfigured the one before. Every
 * id must be in `AGENT_MODELS` (enforced by test).
 */
export const MODEL_ROUTES: Record<RunTask, readonly string[]> = {
  plan: ["anthropic/claude-sonnet-5.5", "openai/gpt-6.1-sol"],
  build: ["anthropic/claude-sonnet-5.5", "openai/gpt-6.1-sol"],
  // shortcut: no Haiku-class model in the allowlist yet, put Claude Haiku 5.5 first once #321 adds it.
  edit: ["openai/gpt-6-luna", "google/gemini-3.8-flash"],
  fix: ["anthropic/claude-sonnet-5.5", "openai/gpt-6.1-sol"],
  vision: ["anthropic/claude-sonnet-5.5", "google/gemini-3.8-flash"],
};

/** Sent when an image send on Auto finds no model that can read images. */
export const AUTO_NO_VISION_MESSAGE = "Auto has no image-capable model. Pick a model that can read images.";

type RoutableModel = Pick<PublicCatalogModel, "id" | "access" | "vision"> & {
  hidden?: boolean;
  pricing?: ModelPricing;
};

/** A model's blended price; capability's stand-in (unpriced, as client-side, is $0). */
const priceOf = (model: RoutableModel) => (model.pricing ? blendedUsdPerMTok(model.pricing) : 0);

/**
 * The model Auto runs a task on, only among models users may pick (offered to
 * everyone, never hidden, so never a promo model), and for "vision" only among
 * models that read images.
 *
 * With an admin pool (`autoModelIds`), it routes only within the pool: short
 * edits to the cheapest, everything else to the most capable, price standing
 * in for capability (ties: catalog order). Pool ids no longer in the catalog
 * are ignored. Image sends never leave a configured pool; text sends fall back
 * to the fixed `MODEL_ROUTES` when no pool member is usable, so Auto keeps
 * working until the admin fixes the pool. Without a pool, `MODEL_ROUTES`.
 * Undefined when nothing fits.
 */
export function autoRouteModel<M extends RoutableModel>(
  models: readonly M[],
  task: RunTask,
  pool?: readonly string[],
): M | undefined {
  const usable = pickableModels(models);
  const fits = (model: M) => task !== "vision" || model.vision;
  const pooled = usable.filter((model) => pool?.includes(model.id));
  if (pooled.length || (pool?.length && task === "vision")) {
    const cheapest = task === "edit";
    return pooled
      .filter(fits)
      .reduce<M | undefined>(
        (best, model) =>
          !best || (cheapest ? priceOf(model) < priceOf(best) : priceOf(model) > priceOf(best)) ? model : best,
        undefined,
      );
  }
  return MODEL_ROUTES[task]
    .map((id) => usable.find((model) => model.id === id))
    .find((model) => model !== undefined && fits(model));
}

/** The label a run routed by Auto shows on its run block, e.g. "Auto · Claude Sonnet 5.5". */
export const autoRunLabel = (model: { name: string }) => `${AUTO_MODEL.name} · ${model.name}`;
