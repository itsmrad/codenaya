import { SettingsHeader } from "@/features/settings/components/settings-header";
import { UsageSettings } from "@/features/settings/components/usage-settings";

// Blocks on the session in the settings layout; see `instant` there.
export const instant = false;

const UsageSettingsPage = () => {
  return (
    <>
      <SettingsHeader title="Usage" description="Credits left today and this month, and when they reset." />
      <UsageSettings />
    </>
  );
};

export default UsageSettingsPage;
