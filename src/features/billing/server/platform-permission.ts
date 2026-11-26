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
