import {
  parseDeployment, readDodoConfig, type DodoReceiverConfig, type DodoReconcilerConfig,
} from "../src/features/billing/server/dodo-config";

export const LOG_PREFIX = {
  "convex-receiver": "[billingWebhook] receiver",
  "convex-reconciler": "[billingReconcile] reconciler",
} as const;

/**
 * Billing config for this Convex deployment, whose trusted deployment comes only from the
 * Convex-only CODENAYA_DEPLOYMENT. Null (fail closed) when absent, invalid or misconfigured;
 * logs fixed text and variable names only, never values.
 */
export function readConvexBillingConfig(consumer: "convex-receiver"): DodoReceiverConfig | null;
export function readConvexBillingConfig(consumer: "convex-reconciler"): DodoReconcilerConfig | null;
export function readConvexBillingConfig(
  consumer: "convex-receiver" | "convex-reconciler",
): DodoReceiverConfig | DodoReconcilerConfig | null {
  const deployment = parseDeployment(process.env.CODENAYA_DEPLOYMENT);
  if (!deployment) {
    console.error(`${LOG_PREFIX[consumer]} not configured: CODENAYA_DEPLOYMENT is missing or invalid.`);
    return null;
  }
  try {
    return consumer === "convex-receiver"
      ? readDodoConfig(consumer, deployment)
      : readDodoConfig(consumer, deployment);
  } catch (error) {
    // Config errors name the variable only, never its value.
    console.error(`${LOG_PREFIX[consumer]} not configured:`, error instanceof Error ? error.message : "unknown error");
    return null;
  }
}
