import { AuthConfig } from "convex/server";

const clerkDomain =
  process.env.CLERK_JWT_ISSUER_DOMAIN || "https://glad-moray-958.clerk.accounts.dev";

export default {
  providers: [
    {
      domain: clerkDomain,
      applicationID: "convex",
    },
    {
      type: "customJwt",
      issuer: clerkDomain,
      jwks: `${clerkDomain}/.well-known/jwks.json`,
      algorithm: "RS256",
    },
  ],
} satisfies AuthConfig;
