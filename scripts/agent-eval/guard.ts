export const DEV_DEPLOYMENT = "outgoing-buffalo-802";
type Env = Record<string, string | undefined>;

/** Fails closed before any Clerk or Convex call: dev Clerk, dev Convex, a local app only. */
export function assertDevTarget(env: Env, baseUrl: string) {
  if (!env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.startsWith("pk_test_") || !env.CLERK_SECRET_KEY?.startsWith("sk_test_")) {
    throw new Error("Refusing to run: Clerk keys are not development (pk_test_/sk_test_) keys");
  }
  if (convexDeployment(env) !== DEV_DEPLOYMENT) throw new Error(`Refusing to run: NEXT_PUBLIC_CONVEX_URL is not the ${DEV_DEPLOYMENT} dev deployment`);
  if (!["localhost", "127.0.0.1"].includes(hostname(baseUrl))) throw new Error("Refusing to run: --base-url must be localhost or 127.0.0.1");
}

/** The deployment name from NEXT_PUBLIC_CONVEX_URL (`https://<name>.convex.cloud`). */
export const convexDeployment = (env: Env) => hostname(env.NEXT_PUBLIC_CONVEX_URL ?? "").split(".")[0];

const hostname = (url: string) => {
  try { return new URL(url).hostname; } catch { return ""; }
};
