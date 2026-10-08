import { httpRouter } from "convex/server";
import { Webhook } from "svix";

import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

const http = httpRouter();

type ClerkUserEvent =
  | {
      kind: "upsert";
      clerkUserId: string;
      email?: string;
      name?: string;
      imageUrl?: string;
      updatedAt: number;
    }
  | { kind: "delete"; clerkUserId: string }
  | { kind: "ignore" };

const optionalString = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * Narrows a verified Clerk payload to the fields we store. Returns null for a
 * user event that is missing what we need, so the caller can answer 400.
 */
function parseClerkUserEvent(payload: unknown): ClerkUserEvent | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { type, data } = payload as { type?: unknown; data?: unknown };
  if (
    type !== "user.created" &&
    type !== "user.updated" &&
    type !== "user.deleted"
  ) {
    return { kind: "ignore" };
  }
  if (typeof data !== "object" || data === null) return null;
  const user = data as Record<string, unknown>;
  if (typeof user.id !== "string") return null;

  if (type === "user.deleted") {
    return { kind: "delete", clerkUserId: user.id };
  }
  if (typeof user.updated_at !== "number") return null;

  const emails = Array.isArray(user.email_addresses) ? user.email_addresses : [];
  const primaryEmail = emails.find(
    (entry: { id?: unknown }) => entry?.id === user.primary_email_address_id,
  ) as { email_address?: unknown } | undefined;
  const fullName = [user.first_name, user.last_name]
    .filter((part) => typeof part === "string" && part.length > 0)
    .join(" ");

  return {
    kind: "upsert",
    clerkUserId: user.id,
    email: optionalString(primaryEmail?.email_address),
    name: optionalString(fullName) ?? optionalString(user.username),
    imageUrl: optionalString(user.image_url),
    updatedAt: user.updated_at,
  };
}

/**
 * Clerk user lifecycle webhook (Svix-signed). Configure in the Clerk dashboard
 * with events `user.created`, `user.updated`, `user.deleted`, and put the
 * endpoint's signing secret in the Convex env as `CLERK_WEBHOOK_SECRET`.
 */
http.route({
  path: "/clerk-users-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.CLERK_WEBHOOK_SECRET;
    if (!secret) {
      // 5xx so Svix keeps retrying until the secret is configured.
      console.error("CLERK_WEBHOOK_SECRET is not configured");
      return new Response("Webhook not configured", { status: 500 });
    }

    const body = await request.text();
    try {
      // Checks the signature and rejects timestamps outside Svix's tolerance.
      new Webhook(secret).verify(body, {
        "svix-id": request.headers.get("svix-id") ?? "",
        "svix-timestamp": request.headers.get("svix-timestamp") ?? "",
        "svix-signature": request.headers.get("svix-signature") ?? "",
      });
    } catch {
      return new Response("Invalid signature", { status: 400 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return new Response("Invalid payload", { status: 400 });
    }

    const event = parseClerkUserEvent(payload);
    if (!event) {
      return new Response("Invalid payload", { status: 400 });
    }

    if (event.kind === "upsert") {
      await ctx.runMutation(internal.users.upsertFromClerk, {
        clerkUserId: event.clerkUserId,
        email: event.email,
        name: event.name,
        imageUrl: event.imageUrl,
        updatedAt: event.updatedAt,
      });
    } else if (event.kind === "delete") {
      await ctx.runMutation(internal.users.markDeleted, {
        clerkUserId: event.clerkUserId,
      });
    }

    return new Response(null, { status: 200 });
  }),
});

export default http;
