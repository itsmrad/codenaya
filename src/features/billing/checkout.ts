/**
 * Starting a Dodo checkout from the Billing tab: `POST /api/billing/checkout`
 * answers `{ url }` or `{ error, code? }`, which the UI shows as short copy.
 */

export type CheckoutSku = "pro_monthly" | "top_up";

const CODE_MESSAGES: Record<string, string> = {
  cross_origin: "That request was blocked. Reload the page and try again.",
  billing_on_hold: "Billing is on hold for your account. Contact support.",
  checkout_unknown:
    "We couldn't confirm the checkout was created. Please wait a minute before trying again — if it keeps happening, contact support.",
  checkout_pending: "You already have a checkout open. Finish it, or try again in a few minutes.",
  already_subscribed: "You're already on Pro.",
  not_pro: "Credit top-ups are for Pro subscribers.",
  top_up_cap: "You've reached the limit of active top-ups.",
  support_required: "Your account needs a quick check first. Contact support.",
  email_required: "Add a verified email to your account first.",
  checkout_unavailable: "Checkout is unavailable right now. Try again shortly.",
  billing_unavailable: "Billing is temporarily unavailable. Try again shortly.",
};

const STATUS_MESSAGES: Record<number, string> = {
  401: "Your session expired. Sign in again to continue.",
  404: "Billing isn't available right now.",
  429: "Too many attempts. Wait a minute and try again.",
  502: CODE_MESSAGES.checkout_unavailable,
  503: CODE_MESSAGES.billing_unavailable,
};

const GENERIC_MESSAGE = "Couldn't start checkout. Try again.";

/** The copy for a failed checkout: by its code, else its status, else generic. */
export const checkoutErrorMessage = (status: number, code?: unknown) =>
  (typeof code === "string" && Object.hasOwn(CODE_MESSAGES, code) ? CODE_MESSAGES[code] : undefined) ??
  (Object.hasOwn(STATUS_MESSAGES, status) ? STATUS_MESSAGES[status] : GENERIC_MESSAGE);

/** Asks for a checkout URL. Only an https URL is returned for navigation. */
export async function startCheckout(sku: CheckoutSku): Promise<{ url: string } | { error: string }> {
  let res: Response;
  try {
    res = await fetch("/api/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sku }),
    });
  } catch {
    return { error: GENERIC_MESSAGE };
  }
  const body: unknown = await res.json().catch(() => null);
  const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (res.ok && typeof fields.url === "string" && fields.url.startsWith("https://")) return { url: fields.url };
  return { error: res.ok ? GENERIC_MESSAGE : checkoutErrorMessage(res.status, fields.code) };
}
