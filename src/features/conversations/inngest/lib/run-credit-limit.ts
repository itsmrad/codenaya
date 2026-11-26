import { convex } from "@/lib/convex-client";
import { type RunSource } from "@/features/billing/credits";
import { readPlatformPermission } from "@/features/billing/server/platform-permission";
import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";

/** Call inside a durable step: snapshot the real owner's balance once per run. */
export async function runCreditLimit(internalKey: string, projectId: Id<"projects">, source: RunSource) {
  if (source === "byok") return null;
  const project = await convex.query(api.system.getProjectById, { internalKey, projectId });
  if (!project || project.deletingAt) throw new Error("Project not found");
  const view = await readPlatformPermission({ internalKey, userId: project.ownerId });
  if (!view.platformAllowed) throw new Error(view.reason === "deleted" ? "User not found" : "Billing access is on hold");
  if (source === "promo") return null;
  return view.billingEnabled || process.env.CREDIT_LIMITS_ENFORCED === "true" ? view.creditsLeft : null;
}
