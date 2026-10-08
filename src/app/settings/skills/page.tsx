import { SettingsHeader } from "@/features/settings/components/settings-header";
import { SkillsGallery } from "@/features/skills/components/skills-gallery";

// Blocks on the session in the settings layout; see `instant` there.
export const instant = false;

const SkillsSettingsPage = () => {
  return (
    <>
      <SettingsHeader
        title="Skills"
        description="Reusable instructions your agent loads when a task matches."
      />
      <SkillsGallery />
    </>
  );
};

export default SkillsSettingsPage;
