import { UserProfile } from "@clerk/nextjs";
import { notFound } from "next/navigation";

import { AccountTabs } from "@/features/settings/components/account-tabs";
import { SettingsHeader } from "@/features/settings/components/settings-header";
import { ACCOUNT_SETTINGS_URL } from "@/features/settings/nav";

// Blocks on the session in the settings layout; see `instant` there.
export const instant = false;

// Brand theme comes from ClerkProvider; these fit the card to the page and
// match the other settings cards. Clerk's navbar is replaced by AccountTabs,
// which also keeps its Billing page out of the UI (#144). Style objects,
// not classes, where Clerk's own rule would win (see providers.tsx).
const appearance = {
  elements: {
    rootBox: { width: "100%" },
    cardBox: {
      width: "100%",
      maxWidth: "none",
      border: "1px solid var(--border)",
      // rounded-md, like the other settings cards.
      borderRadius: "calc(var(--radius) - 2px)",
      height: "auto",
      boxShadow: "none",
    },
    scrollBox: { borderRadius: "inherit", boxShadow: "none" },
    navbar: { display: "none" },
    // `&&` outranks Clerk's mobile rule that shows the row again.
    navbarMobileMenuRow: { "&&": { display: "none" } },
    // The device icons are hard-coded dark grey, invisible on a dark card.
    activeDeviceIcon: { ".dark &": { filter: "invert(0.8)" } },
  },
};

type AccountSettingsPageProps = {
  params: Promise<{ rest?: string[] }>;
};

const AccountSettingsPage = async ({ params }: AccountSettingsPageProps) => {
  // Clerk still serves its Billing page by URL; billing ships on Polar (#105).
  if ((await params).rest?.[0] === "billing") notFound();

  return (
    <>
      <SettingsHeader
        title="Account"
        description="Your profile, sign-in methods and active devices."
      />
      <AccountTabs />
      <UserProfile
        routing="path"
        path={ACCOUNT_SETTINGS_URL}
        appearance={appearance}
      />
    </>
  );
};

export default AccountSettingsPage;
