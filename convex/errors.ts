import { ConvexError } from "convex/values";

/**
 * The codes a client may branch on (docs/ENGINEERING.md §3). Convex replaces a
 * plain `Error`'s message with "Server Error" in production, but keeps the
 * `data` of a `ConvexError`, so user-facing failures throw `appError`.
 */
export type AppErrorCode =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "UNAUTHENTICATED"
  | "INVALID_ARGUMENT"
  | "CONFLICT"
  | "LIMIT_EXCEEDED"
  /** A platform run was refused because the account cannot pay for it (#105). */
  | "INSUFFICIENT_CREDITS";

export type AppErrorData = {
  code: AppErrorCode;
  message: string;
} & Record<string, string>;

export const appError = (
  code: AppErrorCode,
  message: string,
  extra?: Record<string, string>,
) => new ConvexError<AppErrorData>({ ...extra, code, message });
