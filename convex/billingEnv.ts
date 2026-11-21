import {
  readDodoConfig, type DodoDeployment, type DodoReceiverConfig, type DodoReconcilerConfig,
} from "../src/features/billing/server/dodo-config";

const DEPLOYMENTS: readonly string[] = ["development", "preview", "staging", "production"] satisfies DodoDeployment[];
export const LOG_PREFIX = {
  "convex-receiver": "[billingWebhook] receiver",
  "convex-reconciler": "[billingReconcile] reconciler",
} as const;

/**
 * The billing mode this Convex deployment's paid credits live in, from
 * CODENAYA_DEPLOYMENT alone (production is live, everything else test, as
 * `readDodoConfig` enforces). Null when absent or invalid: callers fail closed.
 */
export function deploymentBillingMode(): "test_mode" | "live_mode" | null {
  const deployment = process.env.CODENAYA_DEPLOYMENT;
  if (!deployment || !DEPLOYMENTS.includes(deployment)) return null;
  return deployment === "production" ? "live_mode" : "test_mode";
}

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
  const deployment = process.env.CODENAYA_DEPLOYMENT;
  if (!deployment || !DEPLOYMENTS.includes(deployment)) {
    console.error(`${LOG_PREFIX[consumer]} not configured: CODENAYA_DEPLOYMENT is missing or invalid.`);
    return null;
  }
  try {
    return consumer === "convex-receiver"
      ? readDodoConfig(consumer, deployment as DodoDeployment)
      : readDodoConfig(consumer, deployment as DodoDeployment);
  } catch (error) {
    // Config errors name the variable only, never its value.
    console.error(`${LOG_PREFIX[consumer]} not configured:`, error instanceof Error ? error.message : "unknown error");
    return null;
  }
}
