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
        title="Back from checkout"
        description="If you completed payment, it's being confirmed — credits appear here automatically (usually under a minute). If you cancelled, nothing was charged."
      />
      <BillingSummary />
      <Link href={BILLING_SETTINGS_URL} className="text-sm underline underline-offset-2 hover:text-foreground">
        Back to Billing
      </Link>
    </>
  );
};

export default BillingReturnPage;
