import { SettingsHeader } from "@/features/settings/components/settings-header";
import { SkillsGallery } from "@/features/skills/components/skills-gallery";

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
