// Server consumers only. Read per request; never return this config to a client or log it.
type Env = Readonly<Record<string, string | undefined>>;
export type DodoDeployment = "development" | "preview" | "staging" | "production";
export type DodoEnvironment = "test_mode" | "live_mode";

type DodoCommonConfig = {
  environment: DodoEnvironment;
  businessId: string;
};

export type DodoNextConfig = DodoCommonConfig & {
  apiKey: string;
  proProductId: string;
  brandId?: string;
  returnUrl: string;
} & ({ topUpsEnabled: false } | { topUpsEnabled: true; topUpProductId: string });

export type DodoReceiverConfig = DodoCommonConfig & {
  webhookKey: string;
  webhookKeyPrevious?: string;
};

export type DodoReconcilerConfig = DodoCommonConfig & {
  apiKey: string;
  proProductId: string;
  topUpProductId?: string;
};

function configured(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value && !/^PLACEHOLDER_/i.test(value) ? value : undefined;
}

function required(env: Env, name: string): string {
  const value = configured(env, name);
  if (!value) throw new Error(`Billing configuration requires ${name}.`);
  return value;
}

const DEPLOYMENTS: readonly string[] = ["development", "preview", "staging", "production"] satisfies DodoDeployment[];

/** The trusted deployment from `CODENAYA_DEPLOYMENT`; null when absent or invalid (fail closed). */
export function parseDeployment(value: string | undefined): DodoDeployment | null {
  return value !== undefined && DEPLOYMENTS.includes(value) ? value as DodoDeployment : null;
}

function readEnvironment(env: Env, deployment: DodoDeployment): DodoEnvironment {
  if (!parseDeployment(deployment)) {
    throw new Error("Billing configuration requires an explicit deployment.");
  }
  const environment = required(env, "DODO_PAYMENTS_ENVIRONMENT");
  if (
    environment !== env.DODO_PAYMENTS_ENVIRONMENT ||
    (environment !== "test_mode" && environment !== "live_mode") ||
    environment !== (deployment === "production" ? "live_mode" : "test_mode")
  ) {
    throw new Error("Billing environment is incompatible with deployment.");
  }
  // The future SDK must select its standard endpoint from environment alone.
  if (env.DODO_PAYMENTS_BASE_URL || env.DODO_PAYMENTS_API_BASE_URL) {
    throw new Error("Billing base URL overrides are prohibited.");
  }
  return environment;
}

function readReturnUrl(env: Env, deployment: DodoDeployment): string {
  const appUrl = required(env, "NEXT_PUBLIC_APP_URL");
  const returnUrl = required(env, "DODO_PAYMENTS_RETURN_URL");
  let origin: URL;
  let target: URL;
  try {
    origin = new URL(appUrl);
    target = new URL(returnUrl);
  } catch {
    throw new Error("Billing URLs must be absolute trusted URLs.");
  }
  const productionOrigin = "https://www.codenaya.tech";
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  const allowedOrigin = deployment === "production"
    ? origin.origin === productionOrigin
    : origin.hostname !== "codenaya.tech" && !origin.hostname.endsWith(".codenaya.tech") &&
      (local ? origin.protocol === "http:" || origin.protocol === "https:" :
        origin.protocol === "https:");
  if (
    !allowedOrigin || origin.username || origin.password ||
    origin.hostname.endsWith(".") ||
    appUrl !== origin.origin ||
    returnUrl !== `${origin.origin}/settings/billing/return` ||
    target.origin !== origin.origin
  ) {
    throw new Error("Billing return URL must use the fixed path on the trusted app origin.");
  }
  return returnUrl;
}

/**
 * Checkout disabled => null, even with placeholders. Receiver and reconciler remain available
 * so reversals and already settled money are still processed.
 */
export function readDodoConfig(
  consumer: "next", deployment: DodoDeployment, env?: Env,
): DodoNextConfig | null;
export function readDodoConfig(
  consumer: "convex-receiver", deployment: DodoDeployment, env?: Env,
): DodoReceiverConfig;
export function readDodoConfig(
  consumer: "convex-reconciler", deployment: DodoDeployment, env?: Env,
): DodoReconcilerConfig;
export function readDodoConfig(
  consumer: "next" | "convex-receiver" | "convex-reconciler", deployment: DodoDeployment, env: Env = process.env,
): DodoNextConfig | DodoReceiverConfig | DodoReconcilerConfig | null {
  if (consumer === "next" && typeof window !== "undefined") throw new Error("Billing configuration is server-only.");
  if (consumer !== "next" && consumer !== "convex-receiver" && consumer !== "convex-reconciler") {
    throw new Error("Unknown billing configuration consumer.");
  }
  if (consumer === "next" && env.CODENAYA_BILLING_ENABLED !== "true") return null;
  const common: DodoCommonConfig = {
    environment: readEnvironment(env, deployment),
    businessId: required(env, "DODO_PAYMENTS_BUSINESS_ID"),
  };
  if (consumer === "convex-receiver") {
    return {
      ...common,
      webhookKey: required(env, "DODO_PAYMENTS_WEBHOOK_KEY"),
      webhookKeyPrevious: configured(env, "DODO_PAYMENTS_WEBHOOK_KEY_PREVIOUS"),
    };
  }
  if (consumer === "convex-reconciler") {
    return {
      ...common,
      apiKey: required(env, "DODO_PAYMENTS_API_KEY"),
      proProductId: required(env, "DODO_PAYMENTS_PRO_PRODUCT_ID"),
      topUpProductId: configured(env, "DODO_PAYMENTS_TOP_UP_PRODUCT_ID"),
    };
  }
  if (env.CREDIT_LIMITS_ENFORCED !== "true") {
    throw new Error("Billing requires CREDIT_LIMITS_ENFORCED=true.");
  }
  return {
    ...common,
    apiKey: required(env, "DODO_PAYMENTS_API_KEY"),
    proProductId: required(env, "DODO_PAYMENTS_PRO_PRODUCT_ID"),
    brandId: configured(env, "DODO_PAYMENTS_BRAND_ID"),
    returnUrl: readReturnUrl(env, deployment),
    ...(env.CODENAYA_BILLING_TOP_UPS_ENABLED === "true"
      ? { topUpsEnabled: true, topUpProductId: required(env, "DODO_PAYMENTS_TOP_UP_PRODUCT_ID") }
      : { topUpsEnabled: false }),
  };
}
