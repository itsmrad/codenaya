"use client";

import { UserButton } from "@clerk/nextjs";
import { SettingsIcon } from "lucide-react";

import { ACCOUNT_SETTINGS_URL, SETTINGS_URL } from "@/features/settings/nav";

interface UserMenuProps {
  /** Tailwind size class for the avatar, e.g. `size-7`. */
  avatarClassName: string;
}

/**
 * Clerk's user button with a link to the app's settings page. Clerk's own
 * "Manage account" is hidden because Settings > Account embeds the same
 * profile; any profile link Clerk still renders navigates there too.
 */
export const UserMenu = ({ avatarClassName }: UserMenuProps) => {
  return (
    <UserButton
      userProfileMode="navigation"
      userProfileUrl={ACCOUNT_SETTINGS_URL}
      appearance={{
        elements: {
          avatarBox: avatarClassName,
          // An object, not a Tailwind class: Clerk's own styles outrank `hidden`.
          userButtonPopoverActionButton__manageAccount: { display: "none" },
        },
      }}
    >
      <UserButton.MenuItems>
        <UserButton.Link
          label="Settings"
          labelIcon={<SettingsIcon className="size-4" />}
          href={SETTINGS_URL}
        />
      </UserButton.MenuItems>
    </UserButton>
  );
};
