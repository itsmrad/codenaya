import Link from "next/link";

import { BillingSummary } from "@/features/settings/components/billing-settings";
import { SettingsHeader } from "@/features/settings/components/settings-header";
import { BILLING_SETTINGS_URL } from "@/features/settings/nav";

// Blocks on the session in the settings layout; see `instant` there.
export const instant = false;

/**
 * Where Dodo sends the browser after checkout. Its query params are never read:
 * only the signed webhook changes billing state, and the summary shows it live.
 */
const BillingReturnPage = () => {
  return (
    <>
      <SettingsHeader
        title="Thanks — your payment is being confirmed"
        description="Credits appear here automatically once Dodo confirms it (usually under a minute)."
      />
      <BillingSummary />
      <Link href={BILLING_SETTINGS_URL} className="text-sm underline underline-offset-2 hover:text-foreground">
        Back to Billing
      </Link>
    </>
  );
};

export default BillingReturnPage;
