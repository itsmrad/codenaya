import { redirect } from "next/navigation";

import { ACCOUNT_SETTINGS_URL } from "@/features/settings/nav";

// Blocks on the session in the settings layout; see `instant` there.
export const instant = false;

const SettingsPage = () => {
  redirect(ACCOUNT_SETTINGS_URL);
};

export default SettingsPage;
