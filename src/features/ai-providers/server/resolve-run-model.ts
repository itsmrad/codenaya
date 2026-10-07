import { NextResponse } from "next/server";
import { z } from "zod";

import { convex } from "@/lib/convex-client";
import {
  type AgentModelChoice,
  resolveAgentModelId,
} from "@/features/conversations/agent-models";
import {
  OPENROUTER_MODELS,
  openRouterModel,
} from "@/features/conversations/inngest/lib/openrouter-model";

import { modelIdsFor, runModelLabel, titleModelFor } from "../registry";
import { buildAgentKitModel } from "./agentkit-model";
import { openProviderKey } from "./sealed-key";
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
}

/** A choice the route refuses: someone else's key (403) or a model it lacks (400). */
export class ModelChoiceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403,
  ) {
    super(message);
  }
}

const toChoice = (input: ModelChoiceInput): AgentModelChoice =>
  typeof input === "object" ? input : { modelId: input ?? "" };

const platformChoice = (modelId: string): RunModelChoice => {
  const id = resolveAgentModelId(modelId);
  return { modelId: id, label: runModelLabel(id) };
};

/**
 * Route-side check. Platform ids outside the allowlist fall back to the
 * default, as before; a BYOK choice must name a key the caller owns and a model
 * that key's provider offers.
 */
export async function validateModelChoice({
  internalKey,
  userId,
  model,
}: {
  internalKey: string;
  userId: string;
  model: ModelChoiceInput;
}): Promise<RunModelChoice> {
  const { keyId, modelId } = toChoice(model);
  if (!keyId) {
    return platformChoice(modelId);
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

  return { keyId: key._id, modelId, label: runModelLabel(modelId, key) };
}

/**
 * `validateModelChoice` for route handlers: a refused choice comes back as the
 * JSON error response to return.
 *
 *   const { runModel, rejected } = await requireModelChoice({ ... });
 *   if (rejected) return rejected;
 */
export async function requireModelChoice(
  args: Parameters<typeof validateModelChoice>[0],
): Promise<
  | { runModel: RunModelChoice; rejected?: undefined }
  | { runModel?: undefined; rejected: NextResponse }
> {
  try {
    return { runModel: await validateModelChoice(args) };
  } catch (error) {
    if (error instanceof ModelChoiceError) {
      return {
        rejected: NextResponse.json({ error: error.message }, { status: error.status }),
      };
    }
    throw error;
  }
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
}

/**
 * Run-side resolution. Throws `ProviderKeyError` when the key is gone, not
 * owned by the project's owner, marked invalid, or no longer offers the model.
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
    const modelId = resolveAgentModelId(choice.modelId);
    return {
      coding: (temperature) => openRouterModel(modelId, temperature),
      title: (temperature) => openRouterModel(OPENROUTER_MODELS.title, temperature),
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
  };
}

/**
 * Whether a failed inference means the provider refused the key itself:
 * unauthorized, forbidden, payment required, or out of quota. Plain rate
 * limits and server errors are not the key's fault.
 */
export function isProviderKeyRejection(error: unknown): boolean {
  const text = errorText(error);
  return (
    /\b(401|402|403)\b/.test(text) ||
    /unauthori[sz]ed|invalid[ _-]?api[ _-]?key|incorrect api key|authentication|insufficient[_ ]quota|exceeded your current quota|insufficient credits|payment required/i.test(
      text,
    )
  );
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
