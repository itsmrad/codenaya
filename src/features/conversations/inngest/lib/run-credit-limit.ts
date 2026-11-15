import { convex } from "@/lib/convex-client";
import { creditStanding, type RunSource } from "@/features/billing/credits";
import { PLANS } from "@/features/billing/plans";
import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";

/** Call inside a durable step: snapshot the real owner's balance once per run. */
export async function runCreditLimit(internalKey: string, projectId: Id<"projects">, source: RunSource) {
  if (process.env.CREDIT_LIMITS_ENFORCED !== "true" || source !== "platform") return null;
  const project = await convex.query(api.system.getProjectById, { internalKey, projectId });
  if (!project) throw new Error("Project not found");
  const account = await convex.query(api.credits.getForServer, { internalKey, userId: project.ownerId });
  return creditStanding(PLANS[account?.plan ?? "free"], account, Date.now()).left;
}
