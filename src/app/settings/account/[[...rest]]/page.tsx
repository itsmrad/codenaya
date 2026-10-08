import { UserProfile } from "@clerk/nextjs";

import { ACCOUNT_SETTINGS_URL } from "@/features/settings/nav";

// Blocks on the session in the settings layout; see `instant` there.
export const instant = false;

// Brand theme comes from ClerkProvider; these only fit the card to the page.
// No page header: the card carries its own "Account" title.
const appearance = {
  elements: {
    rootBox: "w-full",
    cardBox: "w-full max-w-none shadow-none border border-border",
  },
};

const AccountSettingsPage = () => {
  return (
    <UserProfile
      routing="path"
      path={ACCOUNT_SETTINGS_URL}
      appearance={appearance}
    />
  );
};

export default AccountSettingsPage;
