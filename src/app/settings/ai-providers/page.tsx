import { AiProvidersSettings } from "@/features/ai-providers/components/ai-providers-settings";
import { SettingsHeader } from "@/features/settings/components/settings-header";

// Blocks on the session in the settings layout; see `instant` there.
export const instant = false;

const AiProvidersSettingsPage = () => {
  return (
    <>
      <SettingsHeader
        title="AI providers"
        description="Bring your own API keys for the models your agent runs on."
      />
      <AiProvidersSettings />
    </>
  );
};

export default AiProvidersSettingsPage;
