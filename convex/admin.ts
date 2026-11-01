import { paginationOptsValidator, paginationResultValidator, type UserIdentity } from "convex/server";
import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, query } from "./_generated/server";
import { appError } from "./errors";

/**
 * The single admin is whoever holds the verified email in the `ADMIN_EMAIL`
 * Convex env var and, when the `ADMIN_USER_ID` env var is set, is that Clerk
 * user (`identity.subject`), so the email alone isn't enough (ADR 0010).
 * Next.js asks `isAdmin` instead of reading the vars, so there is one source.
 * `ADMIN_EMAIL` unset, or an unverified email, fails closed; `ADMIN_USER_ID`
 * unset leaves the email rule alone.
 */
export const isAdminIdentity = (identity: UserIdentity | null): boolean => {
  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const adminUserId = process.env.ADMIN_USER_ID?.trim();
  return (
    !!adminEmail &&
    identity?.emailVerified === true &&
    identity.email?.trim().toLowerCase() === adminEmail &&
    (!adminUserId || identity.subject === adminUserId)
  );
};

/**
 * First line of every admin function. Anyone else gets NOT_FOUND, the same as
 * a function that doesn't exist, so the admin surface can't be probed.
 */
export const requireAdmin = async (ctx: QueryCtx | MutationCtx) => {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity || !isAdminIdentity(identity)) {
    throw appError("NOT_FOUND", "Not found");
  }
  return { id: identity.subject, email: identity.email! };
};

export type Admin = Awaited<ReturnType<typeof requireAdmin>>;

/** Bounds one audit row: a long diff is cut, the full state is in the changed doc. */
const MAX_AUDIT_SUMMARY_LENGTH = 1000;
const MAX_AUDIT_CHANGES = 200;
const MAX_AUDIT_VALUE_LENGTH = 500;

const clip = (text: string, max = MAX_AUDIT_VALUE_LENGTH) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;
const clipOptional = (text: string | undefined) => (text === undefined ? undefined : clip(text));

export type AuditChange = NonNullable<Doc<"adminAuditLog">["changes"]>[number];
type AuditExtra = Pick<Doc<"adminAuditLog">, "changes" | "requestId" | "ip" | "userAgent">;

/**
 * Records an admin change; call it in the same mutation as the change.
 * `extra`: the structured per-field changes and the admin request (ADR 0010).
 */
export const writeAudit = (
  ctx: MutationCtx,
  admin: Admin,
  action: string,
  summary: string,
  extra: AuditExtra = {},
) =>
  ctx.db.insert("adminAuditLog", {
    actorId: admin.id,
    actorEmail: admin.email,
    action,
    summary: clip(summary, MAX_AUDIT_SUMMARY_LENGTH),
    at: Date.now(),
    changes: extra.changes?.slice(0, MAX_AUDIT_CHANGES).map((change) => ({
      field: clip(change.field),
      before: clipOptional(change.before),
      after: clipOptional(change.after),
    })),
    requestId: clipOptional(extra.requestId),
    ip: clipOptional(extra.ip),
    userAgent: clipOptional(extra.userAgent),
  });

/** Whether the caller is the admin. Gates the /admin layout and nav link. */
export const isAdmin = query({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => isAdminIdentity(await ctx.auth.getUserIdentity()),
});

/** The audit log, newest first. */
export const listAudit = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(
    v.object({
      _id: v.id("adminAuditLog"),
      _creationTime: v.number(),
      actorId: v.string(),
      actorEmail: v.string(),
      action: v.string(),
      summary: v.string(),
      at: v.number(),
      changes: v.optional(
        v.array(
          v.object({
            field: v.string(),
            before: v.optional(v.string()),
            after: v.optional(v.string()),
          }),
        ),
      ),
      requestId: v.optional(v.string()),
      ip: v.optional(v.string()),
      userAgent: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, { paginationOpts }) => {
    await requireAdmin(ctx);
    return await ctx.db
      .query("adminAuditLog")
      .withIndex("by_at")
      .order("desc")
      .paginate(paginationOpts);
  },
});
