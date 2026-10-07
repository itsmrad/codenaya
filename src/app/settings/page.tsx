import { redirect } from "next/navigation";

import { ACCOUNT_SETTINGS_URL } from "@/features/settings/nav";

const SettingsPage = () => {
  redirect(ACCOUNT_SETTINGS_URL);
};

export default SettingsPage;
