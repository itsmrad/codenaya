import { AsyncLocalStorage } from "node:async_hooks";
import { Middleware } from "inngest";
import type { createAgent } from "@inngest/agent-kit";
import type { Id } from "../../../../convex/_generated/dataModel";
import type { RunSource } from "../credits";
import { allowedOrdinaryModels } from "../model-access";
import { billingRolloutEnabled } from "./dodo-config";
import { promoKindOf } from "@/features/ai-providers/catalog";
import { isPlatformConfigured, platformCatalog } from "@/features/ai-providers/server/platform-model";
import { convex } from "@/lib/convex-client";
import type { EntitlementView } from "../entitlement";
import { api } from "../../../../convex/_generated/api";

/** Mutation time is authoritative; callers must never supply a clock or cached plan. */
export function readPlatformPermission(args: {
  internalKey: string;
  userId: string;
}): Promise<EntitlementView> {
  return convex.mutation(api.billingEntitlement.getForServer, args);
}

// Approvals live only in this invocation, never in a memoized Inngest step.
export const PERMISSION_FRESH_MS = 30_000;
export const PERMISSION_STOP_REPLY = "This run stopped because access changed. Check your account and model settings before trying again.";
export class InferencePermissionError extends Error {}

type InferenceArgs = {
  internalKey: string;
  projectId: Id<"projects">;
  modelId: string;
  purpose: "coding" | "utility";
  source: RunSource;
  legacyWorker?: boolean;
};

async function inferencePermission({ internalKey, projectId }: Pick<InferenceArgs, "internalKey" | "projectId">) {
  const project = await convex.query(api.system.getProjectById, { internalKey, projectId });
  if (!project || project.deletingAt !== undefined) throw new InferencePermissionError(PERMISSION_STOP_REPLY);
  return convex.mutation(api.billingEntitlement.permissionForServer, { internalKey, userId: project.ownerId });
}

async function assertInference(args: InferenceArgs, view: Awaited<ReturnType<typeof inferencePermission>>) {
  if (view.reason === "deleted" || (args.source !== "byok" && !view.platformAllowed)) {
    throw new InferencePermissionError(PERMISSION_STOP_REPLY);
  }
  if (args.source === "promo" && !(await convex.query(api.promoClaims.hasClaimForProjectOwner, { internalKey: args.internalKey, projectId: args.projectId }))) {
    throw new InferencePermissionError(PERMISSION_STOP_REPLY);
  }
  if (args.source === "platform" && args.purpose === "coding") {
    const restrictFree = billingRolloutEnabled();
    const catalog = await platformCatalog(args.internalKey);
    const selected = catalog.models.find((model) => model.id === args.modelId);
    const legacyWorker = args.legacyWorker && !restrictFree && selected && !promoKindOf(selected.access);
    if (!selected || !isPlatformConfigured(selected.provider) || (!legacyWorker && !allowedOrdinaryModels(catalog, view, { restrictFree }).some((model) => model.id === args.modelId))) {
      throw new InferencePermissionError(PERMISSION_STOP_REPLY);
    }
  }
}

export async function assertPlatformInferenceAllowed(args: InferenceArgs): Promise<void> {
  await assertInference(args, await inferencePermission(args));
}

const inferenceContext = new AsyncLocalStorage<() => Promise<boolean>>();

/** Public SDK hook runs before a new AI gateway operation is reported to Inngest. */
export class InferencePermissionMiddleware extends Middleware.BaseMiddleware {
  readonly id = "inference-permission";
  async transformStepInput(args: Middleware.TransformStepInputArgs) {
    if ((args.stepInfo.stepType === "ai.infer" || args.stepInfo.stepType === "invoke") && !args.stepInfo.memoized) {
      const check = inferenceContext.getStore();
      if (!check || !(await check())) throw new InferencePermissionError(PERMISSION_STOP_REPLY);
    }
    return args;
  }
}
export type PermissionGate = ReturnType<typeof permissionGate>;

/** One gate for all agents in a run, including parallel title and repair fallback. */
export function permissionGate(args: Pick<InferenceArgs, "internalKey" | "projectId" | "source" | "legacyWorker">) {
  let stopped = false;
  const approvals = new Map<string, { at: number; check: Promise<void> }>();
  const check = async (modelId: string, purpose: InferenceArgs["purpose"] = "coding") => {
    if (stopped) return false;
    const key = `${purpose}:${modelId}`;
    let approval = approvals.get(key);
    if (!approval || Date.now() - approval.at >= PERMISSION_FRESH_MS) {
      approval = { at: Date.now(), check: assertPlatformInferenceAllowed({ ...args, modelId, purpose }) };
      approvals.set(key, approval);
    }
    try {
      await approval.check;
      return !stopped;
    } catch {
      // Dependency failure is also a refusal; no summary or cheaper fallback may bypass it.
      stopped = true;
      return false;
    }
  };
  return {
    get stopped() { return stopped; },
    check,
    wrap: <T extends ReturnType<typeof createAgent>>(agent: T, modelId: string, purpose: InferenceArgs["purpose"] = "coding"): T => {
      const run = agent.run.bind(agent);
      agent.run = (...input) => inferenceContext.run(() => check(modelId, purpose), () => run(...input));
      return agent;
    },
  };
}
