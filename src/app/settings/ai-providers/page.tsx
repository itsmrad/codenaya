import { AiProvidersSettings } from "@/features/ai-providers/components/ai-providers-settings";
import { SettingsHeader } from "@/features/settings/components/settings-header";

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
