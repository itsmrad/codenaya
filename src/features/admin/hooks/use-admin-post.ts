import { useReverification } from "@clerk/nextjs";
import { isReverificationCancelledError } from "@clerk/nextjs/errors";

/** An admin route's refusal: its `{ error, code }` and status. */
export class AdminRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/**
 * POSTs JSON to an admin write route. A step-up refusal is returned, not
 * thrown: it carries Clerk's hint, which `useReverification` turns into the
 * verify modal and a retry.
 */
async function postAdmin<Result>(url: string, body: unknown): Promise<Result> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  if (response.ok || json?.code === "reverification_required") return json;
  throw new AdminRequestError(response.status, json?.error ?? "Something went wrong. Try again.", json?.code);
}

/** A POST to one admin route, behind Clerk's step-up modal (ADR 0010). */
export const useAdminPost = <Body, Result>(url: string) =>
  useReverification((body: Body) => postAdmin<Result>(url, body));

/** What to tell the admin when an admin POST fails. */
export const adminPostErrorMessage = (error: unknown) => {
  if (isReverificationCancelledError(error)) return "Verification cancelled. Nothing was changed.";
  if (error instanceof AdminRequestError) return error.message;
  return "Couldn't reach the server. Try again.";
};
