import { SettingsHeader } from "@/features/settings/components/settings-header";
import { WorkspaceSettings } from "@/features/settings/components/workspace-settings";

// Blocks on the session in the settings layout; see `instant` there.
export const instant = false;

const WorkspaceSettingsPage = () => {
  return (
    <>
      <SettingsHeader
        title="Workspace"
        description="How every project opens, on any device you sign in on."
      />
      <WorkspaceSettings />
    </>
  );
};

export default WorkspaceSettingsPage;
