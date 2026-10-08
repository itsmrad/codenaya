import { AppearanceSettings } from "@/features/settings/components/appearance-settings";
import { SettingsHeader } from "@/features/settings/components/settings-header";

// Blocks on the session in the settings layout; see `instant` there.
export const instant = false;

const AppearanceSettingsPage = () => {
  return (
    <>
      <SettingsHeader
        title="Appearance"
        description="How Codenaya looks on this device."
      />
      <AppearanceSettings />
    </>
  );
};

export default AppearanceSettingsPage;
