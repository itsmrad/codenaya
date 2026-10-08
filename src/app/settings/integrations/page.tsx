import { IntegrationsSettings } from "@/features/settings/components/integrations-settings";
import { SettingsHeader } from "@/features/settings/components/settings-header";

// Blocks on the session in the settings layout; see `instant` there.
export const instant = false;

const IntegrationsSettingsPage = () => {
  return (
    <>
      <SettingsHeader
        title="Integrations"
        description="Services your agent can use with your credentials."
      />
      <IntegrationsSettings />
    </>
  );
};

export default IntegrationsSettingsPage;
