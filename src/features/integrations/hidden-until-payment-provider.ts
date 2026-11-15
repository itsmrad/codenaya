/**
 * Payment integrations stay out of discovery until the owner chooses a
 * payment provider. Flip back by emptying these lists when the owner chooses
 * a payment provider.
 *
 * Hiding covers new discovery only: the browsable catalog, deep links,
 * suggestion chips and the built-in skills list. Existing connections still
 * load, resolve and keep their approval gating (`getProvider` is unchanged),
 * and the credential guard still detects these providers' secret keys.
 */

/** Catalog provider ids left out of the browsable and offered lists. */
export const HIDDEN_UNTIL_PAYMENT_PROVIDER_CHOSEN: readonly string[] = ["stripe"];

/** Built-in skill names left out of the skills list. */
export const HIDDEN_SKILLS_UNTIL_PAYMENT_PROVIDER_CHOSEN: readonly string[] = ["stripe-checkout"];
