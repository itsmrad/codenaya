import type { DodoEnvironment } from "./server/dodo-config";

/** Dodo's hosted checkout host per mode. A URL on any other host is never stored or returned. */
export const CHECKOUT_HOSTS: Record<DodoEnvironment, string> = {
  test_mode: "test.checkout.dodopayments.com",
  live_mode: "checkout.dodopayments.com",
};

/** Whether `url` is an `https:` URL on the mode's exact checkout host, with no credentials or explicit port. */
export function isDodoCheckoutUrl(mode: DodoEnvironment, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && parsed.hostname === CHECKOUT_HOSTS[mode] &&
    !parsed.username && !parsed.password && !parsed.port;
}
