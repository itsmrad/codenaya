import { SettingsHeader } from "@/features/settings/components/settings-header";
import { BillingSettings } from "@/features/settings/components/billing-settings";

// Blocks on the session in the settings layout; see `instant` there.
export const instant = false;

const BillingSettingsPage = () => {
  return (
    <>
      <SettingsHeader title="Billing" description="Your plan and credits, and buying more." />
      {/* Flags only: checkout config and secrets stay with the checkout route. */}
      <BillingSettings
        enabled={process.env.CODENAYA_BILLING_ENABLED === "true"}
        topUpsEnabled={process.env.CODENAYA_BILLING_TOP_UPS_ENABLED === "true"}
      />
    </>
  );
};

export default BillingSettingsPage;
