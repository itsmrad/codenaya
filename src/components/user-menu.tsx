"use client";

import { UserButton } from "@clerk/nextjs";
import { SettingsIcon } from "lucide-react";

import { SETTINGS_URL } from "@/features/settings/nav";

interface UserMenuProps {
  /** Tailwind size class for the avatar, e.g. `size-7`. */
  avatarClassName: string;
}

/** Clerk's user button with a link to the app's settings page. */
export const UserMenu = ({ avatarClassName }: UserMenuProps) => {
  return (
    <UserButton appearance={{ elements: { avatarBox: avatarClassName } }}>
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
