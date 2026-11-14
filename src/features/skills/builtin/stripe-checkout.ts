import type { BuiltinSkill } from "../types";

/**
 * Built-in skill: stripe-checkout (#304). Payment Links for static Vite apps,
 * a Checkout Session route plus a verified webhook for Next.js apps, with the
 * secret key and webhook secret kept server-side.
 */
const body = `# Stripe checkout

Use this when the user wants to take payments: a buy button, a paid download, a pricing page or a subscription. Pick the pattern by the app's framework.

## Rules (never break these)

- The **secret key** (\`sk_test_...\`, \`sk_live_...\`), restricted keys (\`rk_...\`) and the **webhook signing secret** (\`whsec_...\`) never go in client code, in any \`VITE_\`/\`NEXT_PUBLIC_\` variable, or in any file. Only the publishable key (\`pk_...\`) may reach the browser.
- Never ask the user to paste a key into chat. Secrets go in the project's **Environment Variables** dialog (or \`setEnvVar\` with a non-public name when the value comes from a tool).
- Never trust a price or amount from the browser. The client says *what* to buy; the server maps that to a Stripe Price ID from its own list.
- Grant access or ship goods only after a verified webhook (or a server-side session lookup), never because the user landed on the success page.
- Build and test in a Stripe **sandbox** (test keys, test card 4242 4242 4242 4242, any future date, any CVC). Switching to live keys is a step the user takes explicitly; never do it for them.

## Products and prices

If the Stripe integration is connected (see "Connected integrations"), you may create the product and price (and a Payment Link) with its tools; writes go through the user's approval. Otherwise tell the user to create them in the Stripe Dashboard and give you the Payment Link URL or the Price ID (\`price_...\`). Price IDs and Payment Link URLs are not secrets.

## Vite app (no server): Payment Links

A Vite app has no server to hold a secret key or receive webhooks, so don't build a Checkout Session flow in it. Use a Payment Link: a Stripe-hosted checkout page per product.

\`\`\`tsx
const EBOOK_PAYMENT_LINK = "https://buy.stripe.com/test_..."; // from the Dashboard or the integration

<a href={EBOOK_PAYMENT_LINK}>Buy the ebook – $10</a> // styled as the app's primary button
\`\`\`

- Sandbox links start with \`https://buy.stripe.com/test_\`; the live link is a different URL the user swaps in when they go live.
- Optional URL parameters: \`?prefilled_email=\` (URL-encoded) and \`?client_reference_id=\` (letters, digits, \`-\`, \`_\`, up to 200 chars; e.g. the signed-in user's id, returned on the Checkout Session).
- Set the link's after-payment behaviour in the Dashboard to redirect to the app's \`/thank-you\` route if wanted. That page only says thanks; it proves nothing about payment.
- For subscription plans, Stripe's embeddable pricing table also works without a server. It uses only the publishable key, read from \`VITE_STRIPE_PUBLISHABLE_KEY\`:

\`\`\`tsx
// index.html: <script async src="https://js.stripe.com/v3/pricing-table.js"></script>
<stripe-pricing-table
  pricing-table-id="prctbl_..."
  publishable-key={import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY}
/>
\`\`\`

  Declare \`stripe-pricing-table\` in \`JSX.IntrinsicElements\` (in a \`.d.ts\`, via \`declare module "react"\`) so TSX accepts it.

- Fulfilment that must be automatic (emailing a file, unlocking an account) needs a webhook, which needs a server. Say so in Notes and suggest a backend function or a Next.js app; don't fake it in the browser.

## Next.js app: Checkout Session + verified webhook

Add \`"stripe"\` to dependencies. Env vars (both secret, server-only): \`STRIPE_SECRET_KEY\` and \`STRIPE_WEBHOOK_SECRET\`. If they aren't set, build the code and ask the user in Notes to add them in Environment Variables. Secrets reach only the cloud sandbox preview, not the in-browser preview.

\`src/lib/stripe.ts\` (server-only):

\`\`\`ts
import "server-only";
import Stripe from "stripe";

export const STRIPE_NOT_SET_UP =
  "Stripe isn't set up: add STRIPE_SECRET_KEY in Environment Variables.";

let client: Stripe | undefined;

// Created on first use, never at import: a missing key must not break \`next build\`.
export function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return (client ??= new Stripe(key));
}

// The only things the browser may buy. Price IDs come from the Dashboard or the integration.
export const PRICES = {
  ebook: "price_...",
} as const;
export type ProductKey = keyof typeof PRICES;
\`\`\`

Add \`"server-only"\` to dependencies too; it makes a client import of this file fail the build.

\`src/app/api/checkout/route.ts\`:

\`\`\`ts
import { NextResponse } from "next/server";
import { getStripe, PRICES, STRIPE_NOT_SET_UP, type ProductKey } from "@/lib/stripe";

export async function POST(req: Request) {
  const stripe = getStripe();
  if (!stripe) return NextResponse.json({ error: STRIPE_NOT_SET_UP }, { status: 503 });
  const form = await req.formData();
  const product = String(form.get("product"));
  if (!Object.hasOwn(PRICES, product)) {
    return NextResponse.json({ error: "Unknown product" }, { status: 400 });
  }
  const origin = new URL(req.url).origin;
  const session = await stripe.checkout.sessions.create({
    mode: "payment", // "subscription" for recurring prices
    line_items: [{ price: PRICES[product as ProductKey], quantity: 1 }],
    success_url: \`\${origin}/thank-you?session_id={CHECKOUT_SESSION_ID}\`,
    cancel_url: \`\${origin}/pricing\`,
  });
  return NextResponse.redirect(session.url!, 303);
}
\`\`\`

The buy button is a plain form, so it works without client JS:

\`\`\`tsx
<form action="/api/checkout" method="POST">
  <input type="hidden" name="product" value="ebook" />
  <Button type="submit">Buy the ebook – $10</Button>
</form>
\`\`\`

If you know the signed-in user, pass \`client_reference_id\` (or \`customer_email\`) from the server-side session, never from the form.

\`src/app/api/stripe/webhook/route.ts\`:

\`\`\`ts
import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";

export async function POST(req: Request) {
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !secret) {
    return NextResponse.json(
      { error: "Stripe isn't set up: add STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET in Environment Variables." },
      { status: 503 },
    );
  }
  const payload = await req.text(); // the raw body: parsing it first breaks the signature
  const signature = req.headers.get("stripe-signature");
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(payload, signature ?? "", secret);
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  if (
    event.type === "checkout.session.completed" ||
    event.type === "checkout.session.async_payment_succeeded"
  ) {
    const session = event.data.object;
    if (session.payment_status !== "unpaid") {
      await fulfillOrder(session.id); // idempotent: Stripe can send an event more than once
    }
  }
  return NextResponse.json({ received: true });
}
\`\`\`

- \`fulfillOrder\` records the session id and skips ids it has already handled, then grants access or sends the goods.
- On the thank-you page, you may look the session up server-side (\`getStripe()?.checkout.sessions.retrieve(id)\`) to show what was bought, but fulfilment stays in the webhook.
- Tell the user how to get \`STRIPE_WEBHOOK_SECRET\`: locally, \`stripe listen --forward-to localhost:3000/api/stripe/webhook\` prints a \`whsec_\` secret; once deployed, add an endpoint for \`<origin>/api/stripe/webhook\` in the Dashboard (events \`checkout.session.completed\` and \`checkout.session.async_payment_succeeded\`) and use its signing secret.

## Notes for the user

Always say: which pattern you used and why, which Dashboard steps remain (product, price or link, webhook endpoint), which env vars to add, that everything is in sandbox mode with the 4242 test card, and that going live means swapping in live keys, price IDs or links themselves.
`;

export const stripeCheckout: BuiltinSkill = {
  name: "stripe-checkout",
  description:
    "Take payments with Stripe safely: Payment Links or a pricing table for static Vite apps, a server-side Checkout Session route and a signature-verified webhook for Next.js. Secret keys stay server-side; sandbox by default. Use when the user wants a buy button, checkout, paid plans or to accept payments.",
  body,
};
