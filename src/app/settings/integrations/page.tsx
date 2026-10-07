import { IntegrationsSettings } from "@/features/settings/components/integrations-settings";
import { SettingsHeader } from "@/features/settings/components/settings-header";

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
